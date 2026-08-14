require "test_helper"

module Oauth
  class EnrichLinearCredentialIdentityJobTest < ActiveJob::TestCase
    setup do
      Oauth::EnrichLinearCredentialIdentityJob.linear_api_http = nil
    end

    teardown do
      Oauth::EnrichLinearCredentialIdentityJob.linear_api_http = nil
    end

    def linear_credential(**overrides)
      app = oauth_apps(:acme_linear)
      app.update!(client_secret: "linear-secret")
      BrokerCredential.create!({
        foreign_id: "linear-linear-pending-abc123",
        name: "Linear – Pending Linear account",
        token_endpoint: Oauth::Providers::Linear::TOKEN_ENDPOINT,
        oauth_app: app,
        provider_subject: "pending-abc123",
        access_token: "lin-token",
        refresh_token: "lin-refresh",
        scopes: %w[read write]
      }.merge(overrides))
    end

    def wrap_credential(credential, name: "#{credential.name} token")
      StaticSecret.create!(
        name: name,
        broker_credential: credential,
        inject_config: { "header" => "Authorization", "formatter" => "Bearer {{ .Value }}" },
        source: SecretSource.new(
          source_type: "token_broker",
          config: { "credential_id" => credential.oid }
        )
      )
    end

    test "updates the credential and wrapper secret names from Linear viewer details" do
      Oauth::EnrichLinearCredentialIdentityJob.linear_api_http = ->(url:, access_token:, body:) {
        assert_equal Oauth::EnrichLinearCredentialIdentityJob::GRAPHQL_ENDPOINT, url
        assert_equal "lin-token", access_token
        assert_equal({ query: Oauth::EnrichLinearCredentialIdentityJob::VIEWER_QUERY }, body)
        { "data" => { "viewer" => { "id" => "LinUser_123", "name" => "Ada Lovelace", "email" => "ada@example.com" } } }
      }
      credential = linear_credential
      secret = wrap_credential(credential)

      Oauth::EnrichLinearCredentialIdentityJob.perform_now(credential.id)

      assert_equal "Linear – Ada Lovelace", credential.reload.name
      assert_equal "LinUser_123", credential.provider_subject
      assert_equal "ada@example.com", credential.provider_email
      assert_equal "linear-linear-linuser_123", credential.foreign_id
      assert_equal "Linear – Ada Lovelace token", secret.reload.name
    end

    test "falls back to email for display name" do
      Oauth::EnrichLinearCredentialIdentityJob.linear_api_http = ->(url:, access_token:, body:) {
        { "data" => { "viewer" => { "id" => "LinUser_123", "name" => nil, "email" => "ada@example.com" } } }
      }
      credential = linear_credential
      secret = wrap_credential(credential)

      Oauth::EnrichLinearCredentialIdentityJob.perform_now(credential.id)

      assert_equal "Linear – ada@example.com", credential.reload.name
      assert_equal "Linear – ada@example.com token", secret.reload.name
    end

    test "does not clobber an operator-renamed wrapper secret" do
      Oauth::EnrichLinearCredentialIdentityJob.linear_api_http = ->(url:, access_token:, body:) {
        { "data" => { "viewer" => { "id" => "LinUser_123", "name" => "Ada Lovelace" } } }
      }
      credential = linear_credential
      secret = wrap_credential(credential, name: "operator name")

      Oauth::EnrichLinearCredentialIdentityJob.perform_now(credential.id)

      assert_equal "Linear – Ada Lovelace", credential.reload.name
      assert_equal "operator name", secret.reload.name
    end

    test "folds a repeat consent into the already connected account" do
      Oauth::EnrichLinearCredentialIdentityJob.linear_api_http = ->(url:, access_token:, body:) {
        { "data" => { "viewer" => { "id" => "LinUser_123", "name" => "Ada Lovelace", "email" => "ada@example.com" } } }
      }
      connected = linear_credential(
        foreign_id: "linear-linear-linuser_123",
        name: "Linear – Ada Lovelace",
        provider_subject: "LinUser_123",
        access_token: "lin-old",
        refresh_token: "lin-refresh-old",
        scopes: %w[read],
        last_refresh: 2.hours.ago
      )
      connected_secret = wrap_credential(connected)
      reconsent = linear_credential(
        foreign_id: "linear-linear-pending-def456",
        provider_subject: "pending-def456",
        access_token: "lin-fresh",
        refresh_token: "lin-refresh-fresh",
        scopes: %w[read write],
        last_refresh: Time.current
      )
      reconsent_secret = wrap_credential(reconsent)

      Oauth::EnrichLinearCredentialIdentityJob.perform_now(reconsent.id)

      assert_equal [ connected.id ], BrokerCredential.where(oauth_app: oauth_apps(:acme_linear)).pluck(:id)
      connected.reload
      assert_equal "lin-fresh", connected.access_token
      assert_equal "lin-refresh-fresh", connected.refresh_token
      assert_equal %w[read write], connected.scopes
      assert_equal "Linear – Ada Lovelace", connected.name
      assert StaticSecret.exists?(connected_secret.id)
      assert_not StaticSecret.exists?(reconsent_secret.id)
    end
  end
end
