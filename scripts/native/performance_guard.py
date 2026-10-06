"""Fail closed on missing native measurements and unequal comparison guarantees."""
import math
import json
import pathlib

MANIFEST_MODELS = tuple(sorted(json.loads((pathlib.Path(__file__).resolve().parents[2] / "protocol/fixtures/manifest.json").read_text())["models"]))
MANIFEST_PIVOTS = tuple(sorted({relation["pivot"]["table"] for definition in json.loads((pathlib.Path(__file__).resolve().parents[2] / "protocol/fixtures/manifest.json").read_text())["models"].values() for relation in definition["relations"].values() if "pivot" in relation}))
SNAPSHOT_PHASES = ("validation", "digest", "staging", "records", "relationSets", "integrity", "commit")
HTTP_RELATION_GROUPS = {
    'Item.classifications': {'sets': 17000, 'targets': 0},
    'Item.salespoints': {'sets': 17000, 'targets': 0},
    'Item.tags': {'sets': 17000, 'targets': 300},
    'Tag.classifiedItems': {'sets': 64, 'targets': 0},
    'Tag.items': {'sets': 64, 'targets': 300},
}

def validate_phases(phases, label):
    if not isinstance(phases, list) or sorted(entry.get("phase") for entry in phases) != sorted(SNAPSHOT_PHASES):
        return [label + " lacks exact finite phase identities"]
    if any(not finite(entry.get("elapsedMilliseconds")) for entry in phases):
        return [label + " has nonfinite phase timing"]
    return []


def finite(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def digest(value):
    return isinstance(value, str) and len(value) == 64 and all(character in '0123456789abcdef' for character in value)


def validate_frames(frames, elapsed, frame_budget, label):
    if not isinstance(frames, dict):
        return [label + ' has malformed frame evidence']
    failures = []
    for field in ('elapsedMilliseconds', 'firstFrameGapMilliseconds', 'finalFrameGapMilliseconds', 'maximumFrameGapMilliseconds', 'callbackCoverageRatio'):
        if not finite(frames.get(field)):
            failures.append(label + ' has no finite complete frame ' + field)
    if failures:
        return failures
    if type(frames.get('frames')) is not int or frames['frames'] < 2:
        failures.append(label + ' has no actual frame callbacks')
    if not finite(elapsed) or abs(frames['elapsedMilliseconds'] - elapsed) > max(10, frame_budget):
        failures.append(label + ' frame observer does not cover the entire operation')
    if not 0.95 <= frames['callbackCoverageRatio'] <= 1.05:
        failures.append(label + ' has insufficient actual frame callback coverage')
    if type(frames.get('estimatedMissedFrames')) is not int or frames['estimatedMissedFrames'] != 0:
        failures.append(label + ' contains estimated missed frames')
    if any(frames[field] > frame_budget * 1.5 for field in ('firstFrameGapMilliseconds', 'finalFrameGapMilliseconds', 'maximumFrameGapMilliseconds')):
        failures.append(label + ' has a frame gap beyond normal measured cadence')
    return failures


def validate_responsiveness(responsiveness, frame_budget, label):
    if not isinstance(responsiveness, dict) or responsiveness.get('boundary') != 'native React RuntimeScheduler task after microtask checkpoint' or responsiveness.get('includesNativeSchedulingDelay') is not True or type(responsiveness.get('callbacks')) is not int or responsiveness['callbacks'] < 2:
        return [label + ' lacks whole application native callback evidence']
    gaps = responsiveness.get('phaseMaximumGaps')
    if not isinstance(gaps, list) or not gaps:
        return [label + ' lacks application phase gap evidence']
    if not finite(responsiveness.get('maximumCallbackGapMilliseconds')) or responsiveness['maximumCallbackGapMilliseconds'] > frame_budget:
        return [label + ' has excessive or missing whole application callback gap']
    for gap in gaps:
        if not isinstance(gap, dict) or gap.get('phase') not in (*SNAPSHOT_PHASES, 'outside-import', 'checkpoint', 'http-transfer', 'http-response-text', 'http-json-decode', 'http-shape-validation') or not isinstance(gap.get('statement'), str) or not gap['statement'] or not finite(gap.get('wallMilliseconds')) or not finite(gap.get('callingThreadCpuMilliseconds')) or gap['wallMilliseconds'] > frame_budget or gap['callingThreadCpuMilliseconds'] > gap['wallMilliseconds'] + 1 or gap['wallMilliseconds'] > responsiveness['maximumCallbackGapMilliseconds'] + 0.001:
            return [label + ' has invalid application phase, statement or CPU gap evidence']
    return []


def validate_pending_delete_public(witness, catalog, pending, label):
    if not isinstance(witness, dict):
        return [label + ' lacks actual public pending-delete relation and cancellation evidence']
    hidden = witness.get('hiddenPublicState')
    zero_fields = ('imageCount', 'tagCount', 'tagIdSum', 'parentTagCount', 'inverseCount', 'inverseQuantitySum', 'inverseWithCount', 'inverseWithSum')
    if not isinstance(hidden, dict) or hidden.get('parentVisible') is not False or hidden.get('tagIds') != [] or hidden.get('inverseItemIds') != [] or any(type(hidden.get(field)) not in (int, float) or hidden[field] != 0 for field in zero_fields):
        return [label + ' exposes pending-deleted public parent memberships or aggregates']
    restored = witness.get('restoredPublicState')
    if not isinstance(restored, dict) or restored.get('parentId') != '3' or restored.get('imageIds') != sorted(['2', '17002', '34002', '51002', '68002', '85002']) or restored.get('imageCount') != 6 or restored.get('imageParents') != ['3'] * 6 or restored.get('tagIds') != ['4', '5', '6'] or restored.get('inverseItemIds') != ['3'] or restored.get('inverseCount') != 1 or restored.get('inverseWithCount') != 1 or restored.get('inverseWithSum') != 3 or restored.get('deletionStatus') != 'cancelled':
        return [label + ' lacks exact public canonical restoration after cancellation']
    before = witness.get('beforeCancellation')
    after = witness.get('afterCancellation')
    if not isinstance(before, dict) or before != after or not digest(before.get('fullOutboxHash')) or not isinstance(before.get('operationStatuses'), list) or [entry.get('operationId') for entry in before['operationStatuses']] != pending.get('beforeOperationIds') or any(entry.get('status') not in ('pending', 'sending', 'conflicted', 'rejected') for entry in before['operationStatuses']):
        return [label + ' cancellation rollback changed complete durable operation state']
    metadata = before.get('metadata')
    if not isinstance(metadata, list) or not {'manifest', 'scope', 'snapshotGeneration', 'cursor:catalog'} <= {row.get('key') for row in metadata} or any(not isinstance(row.get('value'), str) or not row['value'] for row in metadata):
        return [label + ' cancellation rollback lacks complete committed metadata']
    if witness.get('rollbackSentinelObserved') is not True or witness.get('afterRollbackPublicState') != hidden or witness.get('beforeCatalogHash') != catalog.get('storedContentHash') or witness.get('afterCatalogHash') != catalog.get('storedContentHash'):
        return [label + ' cancellation rollback loses public or canonical state']
    return []


def _validate_measurement(measurement, evidence):
    failures = []
    frame_budget = measurement.get('frameBudgetMilliseconds')
    if not finite(frame_budget) or not 1 <= frame_budget <= 40:
        return ['Missing finite measured native frame budget']
    for field, limit in [('importMilliseconds', 10000), ('coldReadMilliseconds', 100), ('warmReadMilliseconds', 50), ('databaseBytes', 32 * 1024 ** 2), ('maximumJavaScriptWorkMilliseconds', frame_budget)]:
        if not finite(measurement.get(field)) or measurement[field] > limit:
            failures.append('Missing or excessive ' + field)
    failures += validate_frames(measurement.get('frameMeasurement', {}), measurement.get('importMilliseconds'), frame_budget, 'SDK import')
    responsiveness = measurement.get('responsivenessMeasurement', {})
    failures += validate_responsiveness(responsiveness, frame_budget, 'SDK import')
    if finite(responsiveness.get('maximumCallbackGapMilliseconds')) and finite(measurement.get('maximumJavaScriptWorkMilliseconds')) and responsiveness['maximumCallbackGapMilliseconds'] > measurement['maximumJavaScriptWorkMilliseconds']:
        failures.append('SDK maximum work omits whole application callback evidence')
    native_baseline = measurement.get('nativeBaselineResidentBytes')
    native_peak = evidence.get('nativeMemory', {}).get('peakResidentBytes')
    if not finite(native_baseline) or native_baseline <= 0 or not finite(native_peak) or native_peak < native_baseline or native_peak - native_baseline > 128 * 1024 ** 2:
        failures.append('Missing or excessive actual native resident memory growth')
    if not finite(measurement.get('peakMemoryBytes')) or not finite(measurement.get('baselineMemoryBytes')) or measurement['baselineMemoryBytes'] <= 0 or measurement['peakMemoryBytes'] < measurement['baselineMemoryBytes'] or measurement['peakMemoryBytes'] - measurement['baselineMemoryBytes'] > 128 * 1024 ** 2:
        failures.append('Missing or excessive Hermes heap growth')
    failures += validate_phases(measurement.get('phaseMeasurements'), 'SDK import')
    catalog = measurement.get('actualCatalog', {})
    records = {row.get('model'): row for row in catalog.get('records', [])}
    if len(catalog.get('records', [])) != len(MANIFEST_MODELS) or tuple(sorted(records)) != MANIFEST_MODELS:
        failures.append('Committed counts do not cover the exact manifest model families')
    for model in MANIFEST_MODELS:
        expected = {'Category': 50, 'Tag': 64, 'Item': 17001, 'Image': 100001}.get(model, 0)
        if records.get(model, {}).get('stored') != expected:
            failures.append('Missing actual committed SQL count for ' + model)
        expected_deleted = {'Item': 1, 'Image': 6}.get(model, 0)
        if records.get(model, {}).get('deleted') != expected_deleted or records.get(model, {}).get('available') != expected - expected_deleted:
            failures.append('Missing independent deleted and available SQL count for ' + model)
    if catalog.get('relationSets') != 100 or catalog.get('pivotRows') != 300 or catalog.get('canonicalPivotRows') != 300:
        failures.append('Missing actual committed relation-set and pivot counts')
    if not digest(catalog.get('storedContentHash')) or not digest(catalog.get('schemaHash')):
        failures.append('Missing actual stored content and DDL oracle')
    pivots = catalog.get('pivotFamilies', [])
    if len(pivots) != len(MANIFEST_PIVOTS) or tuple(sorted(family.get('table') for family in pivots)) != MANIFEST_PIVOTS or any(type(family.get('live')) is not int or type(family.get('canonical')) is not int or family['live'] < 0 or family['canonical'] < 0 for family in pivots) or sum(family['live'] for family in pivots) != catalog.get('pivotRows') or sum(family['canonical'] for family in pivots) != catalog.get('canonicalPivotRows'):
        failures.append('Committed counts do not cover exact pivot families')
    pending = measurement.get('pendingPreservation', {})
    if not isinstance(pending.get('beforeOperationIds'), list) or len(pending['beforeOperationIds']) < 3 or pending['beforeOperationIds'] != pending.get('afterOperationIds') or pending.get('stableAliasBefore') != pending.get('stableAliasAfter') or not pending.get('stableAliasAfter') or pending.get('pendingCreateVisible') is not True or pending.get('pendingEditRetained') is not True or pending.get('pendingDeleteHidden') is not True or pending.get('pendingCascadeChildrenHidden') is not True:
        failures.append('Missing preserved pending create/edit/delete and identity oracle')
    if not digest(pending.get('beforeOutboxHash')) or pending.get('beforeOutboxHash') != pending.get('afterOutboxHash'):
        failures.append('Pending durable operation bodies or statuses changed')
    failures += validate_pending_delete_public(measurement.get('pendingDeletePublicWitness'), catalog, pending, 'SDK import')
    reference = measurement.get('fairReference', {})
    reference_catalog = reference.get('actualCatalog', {})
    if reference.get('rows') != 117115 or not finite(reference.get('elapsedMilliseconds')) or reference['elapsedMilliseconds'] <= 0 or type(reference.get('bulkStatements')) is not int or reference['bulkStatements'] < 1000 or not reference.get('sharedHelpers') or not reference.get('phaseMeasurements'):
        failures.append('Missing inspected comparable direct SQLite baseline')
    failures += validate_phases(reference.get('phaseMeasurements'), 'Direct SQLite import')
    failures += validate_pending_delete_public(reference.get('pendingDeletePublicWitness'), reference_catalog, reference.get('pendingPreservation', {}), 'Direct SQLite import')
    if reference_catalog != catalog:
        failures.append('Direct SQLite baseline has unequal stored content, DDL or relation guarantees')
    if reference.get('pendingPreservation') != pending:
        failures.append('Direct SQLite baseline clears or changes pending guarantees')
    if finite(reference.get('elapsedMilliseconds')) and finite(measurement.get('importMilliseconds')) and measurement['importMilliseconds'] > reference['elapsedMilliseconds'] * 1.25 + 50:
        failures.append('SDK overhead exceeds the declared comparison guard')
    failures += validate_frames(reference.get('frameMeasurement', {}), reference.get('elapsedMilliseconds'), frame_budget, 'Direct SQLite import')
    failures += validate_responsiveness(reference.get('responsivenessMeasurement'), frame_budget, 'Direct SQLite import')
    interaction = measurement.get('uiInteraction', {})
    if interaction.get('driver') not in ('XCUITest native events', 'adb native input events'):
        failures.append('Missing actual native input and scroll driver')
    for phase in ('idle', 'sdk-import', 'reference-import', 'large-http'):
        result = interaction.get('phases', {}).get(phase, {})
        if type(result.get('inputEvents')) is not int or result['inputEvents'] < 2 or type(result.get('scrollEvents')) is not int or result['scrollEvents'] < 2 or not finite(result.get('maximumActionDeliveryMilliseconds')):
            failures.append('Missing delivered native input and scroll during ' + phase)
    idle_delivery = interaction.get('phases', {}).get('idle', {}).get('maximumActionDeliveryMilliseconds')
    for phase in ('idle', 'sdk-import', 'reference-import', 'large-http'):
        delivery = interaction.get('phases', {}).get(phase, {}).get('maximumActionDeliveryMilliseconds')
        if not finite(delivery) or delivery > 500 or (phase != 'idle' and finite(idle_delivery) and delivery > idle_delivery * 2 + frame_budget):
            failures.append('Native UI delivery exceeds end-to-end or idle comparison budget during ' + phase)
    repeats = measurement.get('repeatedImports')
    if not isinstance(repeats, list) or len(repeats) < 2:
        failures.append('Missing repeated import and WAL lifecycle witnesses')
    else:
        for index, repeat in enumerate(repeats):
            if repeat.get('actualCatalog') != catalog or repeat.get('pendingPreservation') != pending or repeat.get('walAfterCheckpointBytes') != 0 or not finite(repeat.get('checkpointMilliseconds')) or not finite(repeat.get('databaseBytes')) or repeat['databaseBytes'] > 32 * 1024 ** 2:
                failures.append('Repeat ' + str(index + 1) + ' loses guarantees or accumulates storage')
            failures += validate_pending_delete_public(repeat.get('pendingDeletePublicWitness'), repeat.get('actualCatalog', {}), repeat.get('pendingPreservation', {}), 'Repeat ' + str(index + 1))
            failures += validate_frames(repeat.get('frameMeasurement', {}), repeat.get('elapsedMilliseconds'), frame_budget, 'Repeat ' + str(index + 1))
            failures += validate_responsiveness(repeat.get('responsivenessMeasurement'), frame_budget, 'Repeat ' + str(index + 1))
    wal = measurement.get('walLifecycle', {})
    if not finite(wal.get('peakWalBytes')) or wal['peakWalBytes'] <= 0 or wal.get('afterCheckpointWalBytes') != 0 or type(wal.get('samples')) is not int or wal['samples'] < 2 or not finite(wal.get('checkpointMilliseconds')):
        failures.append('Missing physical WAL extent and checkpoint evidence')
    rollback = measurement.get('invalidSnapshotRollback', {})
    if rollback.get('sdkRejected') is not True or rollback.get('referenceRejected') is not True or rollback.get('beforeStoredHash') != catalog.get('storedContentHash') or rollback.get('afterStoredHash') != catalog.get('storedContentHash') or rollback.get('referenceAfterStoredHash') != catalog.get('storedContentHash'):
        failures.append('Missing negative snapshot rollback equivalence witness')
    for side in ('sdk', 'reference'):
        before = rollback.get(side + 'MetadataBefore')
        after = rollback.get(side + 'MetadataAfter')
        if not isinstance(before, dict) or set(before) != {'cursor', 'scope', 'snapshotGeneration'} or any(not isinstance(value,str) or not value for value in before.values()) or before != after:
            failures.append('Negative snapshot changes committed metadata for ' + side)
    large = measurement.get('largeHttp', {})
    if large.get('actualHttp') is not True or large.get('completeInstall') is not True or not digest(large.get('candidateFingerprint')) or large['candidateFingerprint'] != evidence.get('candidateFingerprint') or not digest(large.get('packageArchiveSha256')) or large['packageArchiveSha256'] != evidence.get('packageArchiveWitness', {}).get('sha256') or not digest(large.get('fixtureFingerprint')) or large['fixtureFingerprint'] != evidence.get('largeHttpFixture', {}).get('fingerprint') or large['fixtureFingerprint'] != evidence.get('completedLargeFixtureFingerprint'):
        failures.append('Missing complete actual large HTTP install with exact candidate, archive and fixture')
    if not finite(large.get('elapsedMilliseconds')) or large.get('elapsedMilliseconds',0) <= 0:
        failures.append('Missing finite full large HTTP elapsed time')
    failures += validate_frames(large.get('frameMeasurement', {}), large.get('elapsedMilliseconds'), frame_budget, 'Large actual HTTP resnapshot')
    failures += validate_responsiveness(large.get('responsivenessMeasurement'), frame_budget, 'Large actual HTTP resnapshot')
    failures += validate_phases(large.get('phaseMeasurements'), 'Large actual HTTP resnapshot')
    stages = large.get('httpStages', [])
    if not isinstance(stages, list) or sorted(stage.get('phase') for stage in stages) != ['jsonDecode','responseAvailable','responseText','shapeValidation'] or any(stage.get('kind') != 'snapshot' or not finite(stage.get('elapsedMilliseconds')) or not finite(stage.get('heapBytes')) or stage['heapBytes'] <= 0 for stage in stages):
        failures.append('Missing finite HTTP transfer, response text, decode and shape stages')
    if not isinstance(stages, list) or not any(stage.get('phase') == 'responseAvailable' and stage.get('boundary') == 'complete response availability from React Native fetch' for stage in stages):
        failures.append('Large HTTP lacks the actual installed React Native response availability boundary')
    if any(stage.get('phase') in ('jsonDecode','shapeValidation') and (not finite(stage.get('maximumWorkSliceMilliseconds')) or stage['maximumWorkSliceMilliseconds'] > frame_budget) for stage in stages):
        failures.append('Large HTTP decode or shape validation has missing or excessive continuous application work')
    if not finite(large.get('serverSnapshotPreparationMilliseconds')) or not finite(large.get('remainingResponseAvailabilityMilliseconds')) or large.get('serverSnapshotPreparationBoundary') != 'Server-Timing snapshot preparation measured by PHP hrtime before streamed response body emission' or large.get('remainingResponseAvailabilityBoundary') != 'Complete React Native response availability minus snapshot preparation, including server body streaming, transport, native body buffering and scheduling' or 'serverWorkMilliseconds' in large or 'networkAndNativeDeliveryMilliseconds' in large:
        failures.append('Large HTTP timing must distinguish snapshot preparation from remaining complete response availability')
    large_counts = large.get('actualCounts', {}).get('models', [])
    if len(large_counts) != len(MANIFEST_MODELS) or tuple(sorted(row.get('model') for row in large_counts)) != MANIFEST_MODELS or any(type(row.get('records')) is not int or row['records'] != {'Category':50,'Tag':64,'Item':17000,'Image':100001}.get(row['model'],0) for row in large_counts) or large.get('actualCounts', {}).get('relationSets') != 51128:
        failures.append('Missing actual complete large HTTP committed model and relation counts')
    actual_http = large.get('actualCounts', {})
    groups = actual_http.get('relationGroups', [])
    if len(groups) != len(HTTP_RELATION_GROUPS) or any(type(row.get('sets')) is not int or type(row.get('targets')) is not int for row in groups) or {row.get('group'): {'sets': row.get('sets'), 'targets': row.get('targets')} for row in groups} != HTTP_RELATION_GROUPS or actual_http.get('relationTargets') != 600:
        failures.append('Large HTTP relation membership families differ from the independent fixture')
    families = actual_http.get('pivotFamilies', [])
    if len(families) != len(MANIFEST_PIVOTS) or sorted(family.get('table') for family in families) != list(MANIFEST_PIVOTS) or any(type(family.get('live')) is not int or type(family.get('canonical')) is not int or family.get('live') != (300 if family['table'] == 'item_tag' else 0) or family.get('canonical') != (300 if family['table'] == 'item_tag' else 0) for family in families):
        failures.append('Large HTTP physical pivot families differ from the independent fixture')
    oracle = actual_http.get('independentContentOracle', {})
    if oracle.get('source') != 'deterministic PostgreSQL seed 20261002' or oracle.get('checkedRecords') != 117115 or oracle.get('checkedRelationSets') != 51128 or oracle.get('checkedTargets') != 600 or not digest(oracle.get('storedContentHash')) or oracle.get('storedContentHash') != oracle.get('expectedContentHash') or oracle.get('independentContentMatches') is not True or oracle.get('foreignKeysValid') is not True or oracle.get('integrityValid') is not True:
        failures.append('Missing independent seeded large HTTP SQL content and integrity oracle')
    if not finite(large.get('baselineMemoryBytes')) or not finite(large.get('peakMemoryBytes')) or large['baselineMemoryBytes'] <= 0 or large['peakMemoryBytes'] < large['baselineMemoryBytes'] or large['peakMemoryBytes'] - large['baselineMemoryBytes'] > 128 * 1024 ** 2:
        failures.append('Missing bounded whole large HTTP heap measurement')
    batch = measurement.get('batchSync', {})
    if batch.get('operations') != 100 or batch.get('accepted') != 100 or batch.get('actualHttp') is not True:
        failures.append('Missing complete actual HTTP batch synchronization')
    return failures


def validate_measurement(measurement, evidence):
    """Malformed or omitted nested fields always reject the witness."""
    if not isinstance(measurement, dict) or not isinstance(evidence, dict):
        return ['Malformed native performance evidence']
    try:
        return _validate_measurement(measurement, evidence)
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError) as failure:
        return ['Malformed native performance evidence: ' + type(failure).__name__]
