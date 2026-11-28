# Lists the signable targets of the generated mobile-next iOS project (`list`), or pins their
# Release configuration to manual signing with the persistent Apple Distribution identity and the
# App Store profiles from ios-app-store-signing.mjs (`apply`). Signing settings are set per target,
# so Pods targets never see a provisioning profile. Prints counts and fixed error codes only.
require 'json'
require 'xcodeproj'

SIGNABLE = %i[application app_extension messages_extension watch2_app watch2_extension extensionkit_extension].freeze

mode, project_path, file = ARGV
abort('RELEASE_IOS_USAGE') unless %w[list apply].include?(mode) && project_path && file

project = Xcodeproj::Project.open(project_path)
targets = project.native_targets.select { |target| SIGNABLE.include?(target.symbol_type) }
abort('RELEASE_IOS_NO_APP_TARGET') if targets.none? { |target| target.symbol_type == :application }

release = lambda do |target|
  target.build_configurations.find { |config| config.name == 'Release' } || abort('RELEASE_IOS_NO_RELEASE_CONFIGURATION')
end
bundle_id = lambda do |target|
  id = release.call(target).build_settings['PRODUCT_BUNDLE_IDENTIFIER'].to_s
  abort('RELEASE_IOS_BUNDLE_ID_UNRESOLVED') unless id.match?(/\A[A-Za-z0-9.-]+\z/)
  id
end

if mode == 'list'
  File.write(file, JSON.generate(targets.map { |target| bundle_id.call(target) }.uniq))
else
  identity = ENV.fetch('IOS_SIGNING_IDENTITY', '')
  team = ENV.fetch('APPLE_TEAM_ID', '')
  abort('RELEASE_IOS_IDENTITY_INVALID') unless identity.match?(/\A[0-9A-F]{40}\z/)
  abort('RELEASE_IOS_TEAM_INVALID') unless team.match?(/\A[A-Z0-9]{1,30}\z/)
  profiles = JSON.parse(File.read(file))
  attributes = (project.root_object.attributes['TargetAttributes'] ||= {})
  targets.each do |target|
    profile = profiles.fetch(bundle_id.call(target)) { abort('RELEASE_IOS_PROFILE_MISSING') }
    settings = release.call(target).build_settings
    settings['CODE_SIGN_STYLE'] = 'Manual'
    settings['CODE_SIGN_IDENTITY'] = identity
    settings['CODE_SIGN_IDENTITY[sdk=iphoneos*]'] = identity
    settings['DEVELOPMENT_TEAM'] = team
    settings['PROVISIONING_PROFILE_SPECIFIER'] = profile.fetch('name')
    settings['PROVISIONING_PROFILE'] = profile.fetch('uuid')
    target_attributes = (attributes[target.uuid] ||= {})
    target_attributes['ProvisioningStyle'] = 'Manual'
    target_attributes['DevelopmentTeam'] = team
  end
  project.save
end

puts "Signable iOS targets: #{targets.size}"
