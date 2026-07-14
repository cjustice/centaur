require "test_helper"

class ConsoleAuthTest < ActiveSupport::TestCase
  ENV_KEYS = %w[
    CENTAUR_CONSOLE_GOOGLE_CLIENT_ID CENTAUR_CONSOLE_GOOGLE_CLIENT_SECRET
    CENTAUR_CONSOLE_SLACK_CLIENT_ID CENTAUR_CONSOLE_SLACK_CLIENT_SECRET
    CENTAUR_CONSOLE_LINK_ONLY_PROVIDERS
  ].freeze

  setup do
    @prev_env = ENV.to_hash.slice(*ENV_KEYS)
    ENV_KEYS.each { |k| ENV.delete(k) }
    ENV["CENTAUR_CONSOLE_GOOGLE_CLIENT_ID"] = "g-id"
    ENV["CENTAUR_CONSOLE_GOOGLE_CLIENT_SECRET"] = "g-secret"
    ENV["CENTAUR_CONSOLE_SLACK_CLIENT_ID"] = "s-id"
    ENV["CENTAUR_CONSOLE_SLACK_CLIENT_SECRET"] = "s-secret"
  end

  teardown do
    ENV_KEYS.each { |k| ENV.delete(k) }
    @prev_env.each { |k, v| ENV[k] = v }
  end

  test "with no link-only providers both configured providers can log in" do
    assert_equal %w[google slack], ConsoleAuth.providers
    assert_equal %w[google slack], ConsoleAuth.login_providers
    assert_empty ConsoleAuth.linkable_providers
    assert_not ConsoleAuth.link_only?("slack")
  end

  test "a link-only provider is excluded from login and offered as linkable" do
    ENV["CENTAUR_CONSOLE_LINK_ONLY_PROVIDERS"] = "slack"
    assert ConsoleAuth.link_only?("slack")
    assert_equal %w[google], ConsoleAuth.login_providers
    assert_equal %w[slack], ConsoleAuth.linkable_providers
    # Still "configured" -- it just can't log in.
    assert_includes ConsoleAuth.providers, "slack"
  end

  test "link-only list ignores unknown and unconfigured providers and is normalized" do
    ENV["CENTAUR_CONSOLE_LINK_ONLY_PROVIDERS"] = " Slack, github "
    assert_equal %w[slack], ConsoleAuth.link_only_providers
    # A link-only provider with no client credentials is not linkable.
    ENV.delete("CENTAUR_CONSOLE_SLACK_CLIENT_ID")
    assert_empty ConsoleAuth.linkable_providers
  end
end
