require 'xcodeproj'

project_path = File.expand_path('../../examples/react-native/ios/SynloquentExample.xcodeproj', __dir__)
project = Xcodeproj::Project.open(project_path)
application = project.targets.find { |target| target.name == 'SynloquentExample' }
application.build_configurations.each do |configuration|
  configuration.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.synloquent.example'
end
target = project.targets.find { |candidate| candidate.name == 'SynloquentPerformanceUITests' }
unless target
  target = project.new_target(:ui_test_bundle, 'SynloquentPerformanceUITests', :ios, '15.1')
  target.add_dependency(application)
  group = project.main_group.new_group('SynloquentPerformanceUITests', 'SynloquentPerformanceUITests')
  source = group.new_file('NativeInteractionTests.swift')
  target.source_build_phase.add_file_reference(source)
end
target.build_configurations.each do |configuration|
  configuration.build_settings['SWIFT_VERSION'] = '5.0'
  configuration.build_settings['GENERATE_INFOPLIST_FILE'] = 'NO'
  configuration.build_settings['INFOPLIST_FILE'] = 'SynloquentPerformanceUITests/Info.plist'
  configuration.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.synloquent.example.performanceuitests'
  configuration.build_settings['TEST_TARGET_NAME'] = 'SynloquentExample'
  configuration.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
  configuration.build_settings['SUPPORTED_PLATFORMS'] = 'iphonesimulator iphoneos'
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(application)
scheme.add_build_target(target)
scheme.add_test_target(target)
scheme.test_action.build_configuration = 'Release'
scheme.save_as(project_path, 'SynloquentNativePerformance', true)
