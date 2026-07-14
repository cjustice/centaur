require "test_helper"

class Console::IntegrationsControllerTest < ActionDispatch::IntegrationTest
  test "redirects to login when not signed in" do
    get console_integrations_url
    assert_redirected_to login_path
  end

  test "a non-admin sees enabled apps with their start links, logos, and no disabled apps" do
    post login_url, params: { email: users(:member_user).email, password: "password123456" }

    get console_integrations_url
    assert_response :ok

    # Enabled apps show up with their consent start links.
    %w[google slack github].each do |slug|
      assert_select "a[href=?]", "http://www.example.com/oauth/#{slug}/start"
    end
    # Disabled apps are hidden.
    assert_no_match "google-disabled", response.body

    # Known providers render a brand logo (inline SVG).
    assert_select "svg path[fill='#4285F4']" # Google
    assert_select "svg path[fill='#E01E5A']" # Slack
  end

  test "an app already connected under the user's email shows Reconnect and its status" do
    post login_url, params: { email: users(:member_user).email, password: "password123456" }

    credential = BrokerCredential.create!(
      oauth_app: oauth_apps(:acme_google),
      namespace: "acme",
      foreign_id: "google-google-member-sub",
      name: "Google – Member",
      token_endpoint: "https://oauth2.googleapis.com/token",
      client_id: "google-client-id",
      provider_subject: "member-sub",
      provider_email: users(:member_user).email,
      external_user_key: "member-key"
    )

    get console_integrations_url
    assert_response :ok
    assert_select "a.btn-secondary[href=?]", "http://www.example.com/oauth/google/start", text: "Reconnect"
    assert_match "Connected", response.body
    # The other apps are still unconnected.
    assert_select "a.btn-primary[href=?]", "http://www.example.com/oauth/slack/start", text: "Connect"

    # A dead credential asks the user to reconnect rather than claiming success.
    credential.update!(dead: true, dead_reason: "invalid_grant")
    get console_integrations_url
    assert_match "Needs reconnecting", response.body
  end

  test "a credential the user minted shows connected even when the provider email differs" do
    post login_url, params: { email: users(:member_user).email, password: "password123456" }

    BrokerCredential.create!(
      oauth_app: oauth_apps(:acme_google),
      namespace: "acme",
      foreign_id: "google-google-personal-sub",
      name: "Google – Personal",
      token_endpoint: "https://oauth2.googleapis.com/token",
      client_id: "google-client-id",
      provider_subject: "personal-sub",
      provider_email: "personal@gmail.example",
      external_user_key: "personal-key",
      created_by: users(:member_user)
    )

    get console_integrations_url
    assert_response :ok
    assert_select "a.btn-secondary[href=?]", "http://www.example.com/oauth/google/start", text: "Reconnect"
  end

  test "a credential minted for someone else's email does not mark the app connected" do
    post login_url, params: { email: users(:member_user).email, password: "password123456" }

    BrokerCredential.create!(
      oauth_app: oauth_apps(:acme_google),
      namespace: "acme",
      foreign_id: "google-google-other-sub",
      name: "Google – Other",
      token_endpoint: "https://oauth2.googleapis.com/token",
      client_id: "google-client-id",
      provider_subject: "other-sub",
      provider_email: users(:acme_admin).email,
      external_user_key: "other-key"
    )

    get console_integrations_url
    assert_response :ok
    assert_select "a.btn-primary[href=?]", "http://www.example.com/oauth/google/start", text: "Connect"
    assert_no_match "Reconnect", response.body
  end

  test "an admin sees the same page" do
    post login_url, params: { email: users(:acme_admin).email, password: "password123456" }

    get console_integrations_url
    assert_response :ok
    assert_select "a[href=?]", "http://www.example.com/oauth/google/start"
  end

  test "the Linked accounts section is hidden when no provider is link-only" do
    post login_url, params: { email: users(:member_user).email, password: "password123456" }
    get console_integrations_url
    assert_response :ok
    assert_no_match "Linked accounts", response.body
  end

  LINK_ONLY_ENV = %w[
    CENTAUR_CONSOLE_SLACK_CLIENT_ID CENTAUR_CONSOLE_SLACK_CLIENT_SECRET CENTAUR_CONSOLE_LINK_ONLY_PROVIDERS
  ].freeze

  test "a link-only provider renders Connect, then Disconnect once linked" do
    prev = ENV.to_hash.slice(*LINK_ONLY_ENV)
    # A provider must be BOTH configured (client creds) and link-only to appear
    # as a linkable account.
    ENV["CENTAUR_CONSOLE_SLACK_CLIENT_ID"] = "slack-login-client-id"
    ENV["CENTAUR_CONSOLE_SLACK_CLIENT_SECRET"] = "slack-login-secret"
    ENV["CENTAUR_CONSOLE_LINK_ONLY_PROVIDERS"] = "slack"
    member = users(:member_user)
    post login_url, params: { email: member.email, password: "password123456" }

    get console_integrations_url
    assert_response :ok
    assert_match "Linked accounts", response.body
    assert_select "a.btn-primary[href=?]", auth_connect_path(provider: "slack"), text: "Connect"

    member.user_identities.create!(
      provider: "slack", subject: "U-linked", email: member.email, email_verified: true
    )
    get console_integrations_url
    assert_response :ok
    assert_select "form[action=?]", console_identity_path(member.user_identities.find_by(provider: "slack"))
  ensure
    LINK_ONLY_ENV.each { |k| ENV.delete(k) }
    prev&.each { |k, v| ENV[k] = v }
  end
end
