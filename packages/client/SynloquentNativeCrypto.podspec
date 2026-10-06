require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |specification|
  specification.name = 'SynloquentNativeCrypto'
  specification.version = package['version']
  specification.summary = 'Bounded asynchronous system SHA256 streams for Synloquent React Native consumers'
  specification.homepage = 'https://example.invalid/synloquent'
  specification.license = { :type => 'MIT' }
  specification.authors = 'Synloquent contributors'
  specification.platforms = { :ios => '15.1' }
  specification.source = { :git => 'https://example.invalid/synloquent.git', :tag => package['version'] }
  specification.source_files = 'native/ios/**/*.{h,m,mm,cpp}'
  specification.private_header_files = 'native/ios/**/*.h'
  install_modules_dependencies(specification)
end
