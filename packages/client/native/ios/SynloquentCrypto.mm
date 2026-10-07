#import "SynloquentCrypto.h"
#import <CommonCrypto/CommonDigest.h>
#import <React/RCTBridgeModule.h>
#include <array>
#include <os/proc.h>
#include <time.h>
#include <unordered_map>

struct NativeHashContext {
  CC_SHA256_CTX state;
  uint64_t bytes = 0;
  double cpuMilliseconds = 0;
  double wallMilliseconds = 0;
};

static double ReadClockMilliseconds(clockid_t clock) {
  struct timespec measurement;
  if (clock_gettime(clock, &measurement) != 0) return -1;
  return double(measurement.tv_sec) * 1000 + double(measurement.tv_nsec) / 1000000;
}

@implementation SynloquentCrypto {
  dispatch_queue_t _worker;
  std::unordered_map<std::string, NativeHashContext> _contexts;
  dispatch_source_t _memoryPressureSource;
  BOOL _memoryObservationStarted;
  BOOL _memoryInvalidated;
}
RCT_EXPORT_MODULE(NativeSynloquentCrypto)

+ (BOOL)requiresMainQueueSetup { return NO; }

- (instancetype)init {
  if ((self = [super init])) {
    dispatch_queue_attr_t workerAttributes = dispatch_queue_attr_make_with_autorelease_frequency(DISPATCH_QUEUE_SERIAL, DISPATCH_AUTORELEASE_FREQUENCY_WORK_ITEM);
    _worker = dispatch_queue_create("synloquent.sha256.worker", workerAttributes);
  }
  return self;
}

- (NSNumber *)threadCpuMilliseconds {
  const double measurement = ReadClockMilliseconds(CLOCK_THREAD_CPUTIME_ID);
  if (measurement < 0) @throw [NSException exceptionWithName:@"clock_unavailable" reason:@"System calling-thread CPU timing is unavailable." userInfo:nil];
  return @(measurement);
}

- (void)sampleMemory:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  @synchronized (self) {
    if (_memoryInvalidated) { reject(@"memory_closed", @"Native memory observations are closed.", nil); return; }
    if (!_eventEmitterCallback) { reject(@"memory_unavailable", @"Native memory events are not initialized.", nil); return; }
    if (!_memoryObservationStarted) {
      _memoryObservationStarted = YES;
      _memoryPressureSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_MEMORYPRESSURE, 0, DISPATCH_MEMORYPRESSURE_NORMAL | DISPATCH_MEMORYPRESSURE_WARN | DISPATCH_MEMORYPRESSURE_CRITICAL, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
      if (_memoryPressureSource) {
        __weak SynloquentCrypto *weakSelf = self;
        dispatch_source_set_event_handler(_memoryPressureSource, ^{
          SynloquentCrypto *strongSelf = weakSelf;
          if (!strongSelf) return;
          @synchronized (strongSelf) {
            if (strongSelf->_memoryInvalidated || !strongSelf->_memoryPressureSource) return;
            const unsigned long conditions = dispatch_source_get_data(strongSelf->_memoryPressureSource);
            NSString *kind = nil;
            if (conditions & DISPATCH_MEMORYPRESSURE_CRITICAL) kind = @"critical";
            else if (conditions & DISPATCH_MEMORYPRESSURE_WARN) kind = @"warning";
            else if (conditions & DISPATCH_MEMORYPRESSURE_NORMAL) kind = @"normal";
            const double observedAt = ReadClockMilliseconds(CLOCK_MONOTONIC);
            if (kind && observedAt >= 0) [strongSelf emitOnMemoryPressure:@{@"kind": kind, @"source": @"dispatch-memory-pressure", @"observedAtMonotonicMilliseconds": @(observedAt)}];
          }
        });
        dispatch_resume(_memoryPressureSource);
      }
    }
    const size_t headroom = os_proc_available_memory();
    const double sampledAt = ReadClockMilliseconds(CLOCK_MONOTONIC);
    if (sampledAt < 0) { reject(@"memory_unavailable", @"Native memory observation timing is unavailable.", nil); return; }
    resolve(@{@"processHeadroomBytes": headroom ? @(headroom) : NSNull.null, @"systemAvailableBytes": NSNull.null, @"systemLowMemoryThresholdBytes": NSNull.null, @"systemLowMemory": NSNull.null, @"sampledAtMonotonicMilliseconds": @(sampledAt)});
  }
}

- (void)start:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_worker, ^{
    if (self->_contexts.size() >= 8) { reject(@"hash_capacity", @"Too many active hash contexts.", nil); return; }
    NSString *identifier = NSUUID.UUID.UUIDString;
    NativeHashContext context;
    if (CC_SHA256_Init(&context.state) != 1) { reject(@"hash_failed", @"System SHA256 initialization failed.", nil); return; }
    self->_contexts.emplace(identifier.UTF8String, context);
    resolve(identifier);
  });
}

- (void)append:(NSString *)identifier content:(NSString *)content resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_worker, ^{
    auto context = self->_contexts.find(identifier.UTF8String);
    if (context == self->_contexts.end()) { reject(@"hash_context", @"The hash context is closed or unknown.", nil); return; }
    if (content.length > 65536) { reject(@"hash_chunk", @"Hash chunks must contain at most 65536 UTF16 units.", nil); return; }
    const double cpuStarted = ReadClockMilliseconds(CLOCK_THREAD_CPUTIME_ID);
    const double wallStarted = ReadClockMilliseconds(CLOCK_MONOTONIC);
    if (cpuStarted < 0 || wallStarted < 0) { reject(@"clock_unavailable", @"System thread CPU timing is unavailable.", nil); return; }
    NSData *bytes = [content dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:YES];
    if (!bytes || bytes.length > 262144 || context->second.bytes + bytes.length > 268435456) { reject(@"hash_bounds", @"Hash content exceeds its bounded input limit.", nil); return; }
    if (CC_SHA256_Update(&context->second.state, bytes.bytes, static_cast<CC_LONG>(bytes.length)) != 1) { reject(@"hash_failed", @"System SHA256 update failed.", nil); return; }
    context->second.bytes += bytes.length;
    context->second.cpuMilliseconds += ReadClockMilliseconds(CLOCK_THREAD_CPUTIME_ID) - cpuStarted;
    context->second.wallMilliseconds += ReadClockMilliseconds(CLOCK_MONOTONIC) - wallStarted;
    resolve(nil);
  });
}

- (void)finish:(NSString *)identifier resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_worker, ^{
    auto context = self->_contexts.find(identifier.UTF8String);
    if (context == self->_contexts.end()) { reject(@"hash_context", @"The hash context is closed or unknown.", nil); return; }
    const double cpuStarted = ReadClockMilliseconds(CLOCK_THREAD_CPUTIME_ID);
    const double wallStarted = ReadClockMilliseconds(CLOCK_MONOTONIC);
    if (cpuStarted < 0 || wallStarted < 0) { reject(@"clock_unavailable", @"System thread CPU timing is unavailable.", nil); return; }
    std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest;
    if (CC_SHA256_Final(digest.data(), &context->second.state) != 1) { reject(@"hash_failed", @"System SHA256 finalization failed.", nil); return; }
    NSMutableString *hexadecimal = [NSMutableString stringWithCapacity:64];
    for (unsigned char byte : digest) [hexadecimal appendFormat:@"%02x", byte];
    NSDictionary *result = @{@"digest": hexadecimal, @"bytes": @(context->second.bytes), @"cpuMilliseconds": @(context->second.cpuMilliseconds + ReadClockMilliseconds(CLOCK_THREAD_CPUTIME_ID) - cpuStarted), @"wallMilliseconds": @(context->second.wallMilliseconds + ReadClockMilliseconds(CLOCK_MONOTONIC) - wallStarted)};
    self->_contexts.erase(context);
    resolve(result);
  });
}

- (void)cancel:(NSString *)identifier resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(_worker, ^{ self->_contexts.erase(identifier.UTF8String); resolve(nil); });
}

- (void)invalidate {
  @synchronized (self) {
    _memoryInvalidated = YES;
    if (_memoryPressureSource) { dispatch_source_cancel(_memoryPressureSource); _memoryPressureSource = nil; }
  }
  dispatch_async(_worker, ^{ self->_contexts.clear(); });
}

- (void)dealloc {
  if (_memoryPressureSource) dispatch_source_cancel(_memoryPressureSource);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)parameters {
  return std::make_shared<facebook::react::NativeSynloquentCryptoSpecJSI>(parameters);
}
@end
