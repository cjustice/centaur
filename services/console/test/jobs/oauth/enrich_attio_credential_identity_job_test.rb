require "test_helper"

module Oauth
  class EnrichAttioCredentialIdentityJobTest < ActiveJob::TestCase
    setup do
      Oauth::EnrichAttioCredentialIdentityJob.attio_api_http = nil
    end

    teardown do
      Oauth::EnrichAttioCredentialIdentityJob.attio_api_http = nil
    end

    def attio_credential(**overrides)
      app = oauth_apps(:acme_attio)
      app.update!(client_secret: "attio-secret")
      BrokerCredential.create!({
        foreign_id: "attio-attio-pending-abc123",
        name: "Attio – Pending Attio workspace",
        token_endpoint: Oauth::Providers::Attio::TOKEN_ENDPOINT,
        oauth_app: app,
        provider_subject: "pending-abc123",
        access_token: "attio-token",
        refresh_token: nil,
        scopes: %w[record_permission:read object_configuration:read]
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

    test "updates the credential and wrapper secret names from Attio workspace details" do
      Oauth::EnrichAttioCredentialIdentityJob.attio_api_http = ->(url:, access_token:) {
        assert_equal Oauth::EnrichAttioCredentialIdentityJob::SELF_ENDPOINT, url
        assert_equal "attio-token", access_token
        {
          "workspace_id" => "WS_ABC123",
          "workspace_name" => "Acme Sales",
          "workspace_slug" => "acme-sales",
          "authorized_by_workspace_member_id" => "member_123"
        }
      }
      credential = attio_credential(provider_email: "old@example.com")
      secret = wrap_credential(credential)

      Oauth::EnrichAttioCredentialIdentityJob.perform_now(credential.id)

      assert_equal "Attio – Acme Sales", credential.reload.name
      assert_equal "WS_ABC123", credential.provider_subject
      assert_nil credential.provider_email
      assert_equal "attio-attio-ws_abc123", credential.foreign_id
      assert_equal "Attio – Acme Sales token", secret.reload.name
    end

    test "falls back to workspace slug for display name" do
      Oauth::EnrichAttioCredentialIdentityJob.attio_api_http = ->(url:, access_token:) {
        { "workspace_id" => "WS_ABC123", "workspace_name" => nil, "workspace_slug" => "acme-sales" }
      }
      credential = attio_credential
      secret = wrap_credential(credential)

      Oauth::EnrichAttioCredentialIdentityJob.perform_now(credential.id)

      assert_equal "Attio – acme-sales", credential.reload.name
      assert_equal "Attio – acme-sales token", secret.reload.name
    end

    test "does not clobber an operator-renamed wrapper secret" do
      Oauth::EnrichAttioCredentialIdentityJob.attio_api_http = ->(url:, access_token:) {
        { "workspace_id" => "WS_ABC123", "workspace_name" => "Acme Sales" }
      }
      credential = attio_credential
      secret = wrap_credential(credential, name: "operator name")

      Oauth::EnrichAttioCredentialIdentityJob.perform_now(credential.id)

      assert_equal "Attio – Acme Sales", credential.reload.name
      assert_equal "operator name", secret.reload.name
    end

    test "folds a repeat consent into the already connected workspace" do
      Oauth::EnrichAttioCredentialIdentityJob.attio_api_http = ->(url:, access_token:) {
        { "workspace_id" => "WS_ABC123", "workspace_name" => "Acme Sales" }
      }
      connected = attio_credential(
        foreign_id: "attio-attio-ws_abc123",
        name: "Attio – Acme Sales",
        provider_subject: "WS_ABC123",
        access_token: "attio-old",
        scopes: %w[record_permission:read],
        last_refresh: 2.hours.ago
      )
      connected_secret = wrap_credential(connected)
      reconsent = attio_credential(
        foreign_id: "attio-attio-pending-def456",
        provider_subject: "pending-def456",
        access_token: "attio-fresh",
        scopes: %w[record_permission:read object_configuration:read],
        last_refresh: Time.current
      )
      reconsent_secret = wrap_credential(reconsent)

      Oauth::EnrichAttioCredentialIdentityJob.perform_now(reconsent.id)

      assert_equal [ connected.id ], BrokerCredential.where(oauth_app: oauth_apps(:acme_attio)).pluck(:id)
      connected.reload
      assert_equal "attio-fresh", connected.access_token
      assert_equal %w[record_permission:read object_configuration:read], connected.scopes
      assert_equal "Attio – Acme Sales", connected.name
      assert StaticSecret.exists?(connected_secret.id)
      assert_not StaticSecret.exists?(reconsent_secret.id)
    end
  end
end
