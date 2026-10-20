# Adds CHE's screen-sharing broadcast extension (native/iphone/CheBroadcast) to
# the iPhone project that `flutter create` generates in CI, and gives the app
# and the extension the App Group they share frames through. Idempotent: a
# project that already has the target is left as it is.
#
#   ruby tool/add_broadcast_extension.rb [path/to/ios]
#
# Uses the xcodeproj gem (CocoaPods ships it).
require 'fileutils'
require 'xcodeproj'

ROOT = File.expand_path('..', __dir__)
IOS = File.expand_path(ARGV[0] || File.join(ROOT, 'ios'))
NAME = 'CheBroadcast'
SOURCE = File.join(ROOT, 'native', 'iphone')
APP_ID = 'com.cheyapp.chey'

project_path = File.join(IOS, 'Runner.xcodeproj')
abort "No iPhone project at #{project_path}" unless File.directory?(project_path)

# Files on disk first, so a rerun refreshes them even when the target exists.
FileUtils.mkdir_p(File.join(IOS, NAME))
%w[SampleHandler.swift Info.plist CheBroadcast.entitlements Broadcast.xcconfig].each do |file|
  FileUtils.cp(File.join(SOURCE, NAME, file), File.join(IOS, NAME, file))
end
FileUtils.cp(File.join(SOURCE, 'Runner', 'Runner.entitlements'), File.join(IOS, 'Runner', 'Runner.entitlements'))

project = Xcodeproj::Project.open(project_path)
runner = project.targets.find { |t| t.name == 'Runner' } or abort 'No Runner target'

# The app holds the App Group too: it reads the frames the extension writes.
runner.build_configurations.each do |config|
  config.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'Runner/Runner.entitlements'
end

if project.targets.any? { |t| t.name == NAME }
  project.save
  puts "#{NAME} already in the project; files refreshed"
  exit 0
end

ext = project.new_target(:app_extension, NAME, :ios, '16.0', nil, :swift)
group = project.main_group.find_subpath(NAME, true)
group.set_source_tree('<group>')
group.set_path(NAME)
swift = group.new_reference('SampleHandler.swift')
group.new_reference('Info.plist')
group.new_reference('CheBroadcast.entitlements')
xcconfig = group.new_reference('Broadcast.xcconfig')
ext.add_file_references([swift])
# Swift links Foundation and ReplayKit from its imports; a framework reference
# would pin one SDK version's path and break on another Xcode.
ext.frameworks_build_phase.files.to_a.each { |f| f.remove_from_project }
project.objects.select { |o| o.isa == 'PBXFileReference' && o.path.to_s.include?('.sdk/') && o.build_files.empty? }
       .each(&:remove_from_project)

ext.build_configurations.each do |config|
  config.base_configuration_reference = xcconfig
  s = config.build_settings
  s['PRODUCT_NAME'] = NAME
  s['PRODUCT_BUNDLE_IDENTIFIER'] = "#{APP_ID}.#{NAME}"
  s['INFOPLIST_FILE'] = "#{NAME}/Info.plist"
  s['GENERATE_INFOPLIST_FILE'] = 'NO'
  s['CODE_SIGN_ENTITLEMENTS'] = "#{NAME}/CheBroadcast.entitlements"
  s['SWIFT_VERSION'] = '5.0'
  s['IPHONEOS_DEPLOYMENT_TARGET'] = '16.0'
  s['TARGETED_DEVICE_FAMILY'] = '1,2'
  s['SKIP_INSTALL'] = 'YES'
  s['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  # Flutter's archive builds sign nothing (--no-codesign); keep the extension the same.
  s['CODE_SIGN_STYLE'] = 'Automatic'
  s['DEVELOPMENT_TEAM'] = runner.build_configurations.first.build_settings['DEVELOPMENT_TEAM'] || ''
end

# Ship the extension inside the app (PlugIns/CheBroadcast.appex).
runner.add_dependency(ext)
embed = runner.copy_files_build_phases.find { |p| p.symbol_dst_subfolder_spec == :plug_ins } ||
        runner.new_copy_files_build_phase('Embed Foundation Extensions')
embed.symbol_dst_subfolder_spec = :plug_ins
file = embed.add_file_reference(ext.product_reference, true)
file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

# Flutter's "Thin Binary" script must run after the extension is embedded, or
# Xcode reports a build cycle; put the embed phase before it.
phases = runner.build_phases
thin = phases.find { |p| p.respond_to?(:name) && p.name.to_s.include?('Thin Binary') }
if thin
  phases.delete(embed)
  phases.insert(phases.index(thin), embed)
end

project.save
puts "#{NAME} added: #{APP_ID}.#{NAME}, App Group group.#{APP_ID}"
