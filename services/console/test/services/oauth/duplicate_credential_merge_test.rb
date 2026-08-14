require "test_helper"

module Oauth
  class DuplicateCredentialMergeTest < ActiveSupport::TestCase
    setup do
      @app = oauth_apps(:acme_github)
      @app.update!(client_secret: "github-secret")
    end

    def credential(subject:, foreign_id:, **overrides)
      BrokerCredential.create!({
        foreign_id: foreign_id,
        name: "GitHub – #{subject}",
        token_endpoint: Oauth::Providers::Github::TOKEN_ENDPOINT,
        oauth_app: @app,
        provider_subject: subject,
        access_token: "gho-#{subject}",
        scopes: %w[repo],
        last_refresh: Time.current
      }.merge(overrides))
    end

    def wrap(cred)
      StaticSecret.create!(
        name: "#{cred.name} token",
        broker_credential: cred,
        inject_config: { "header" => "Authorization", "formatter" => "Bearer {{ .Value }}" },
        source: SecretSource.new(source_type: "token_broker", config: { "credential_id" => cred.oid })
      )
    end

    test "returns nil when no other credential carries the subject" do
      pending = credential(subject: "pending-abc123", foreign_id: "github-github-pending-abc123")

      assert_nil DuplicateCredentialMerge.new.call(duplicate: pending, subject: "99123")
      assert BrokerCredential.exists?(pending.id)
    end

    test "returns nil for a blank subject" do
      pending = credential(subject: "pending-abc123", foreign_id: "github-github-pending-abc123")

      assert_nil DuplicateCredentialMerge.new.call(duplicate: pending, subject: nil)
      assert BrokerCredential.exists?(pending.id)
    end

    test "moves the newer token onto the canonical credential and drops the duplicate" do
      canonical = credential(
        subject: "99123",
        foreign_id: "github-github-99123",
        access_token: "gho-old",
        scopes: %w[repo],
        refresh_token: "ghr-old",
        last_refresh: 2.hours.ago,
        dead: true,
        dead_reason: "invalid_grant",
        failure_count: 3
      )
      canonical_secret = wrap(canonical)
      duplicate = credential(
        subject: "pending-abc123",
        foreign_id: "github-github-pending-abc123",
        access_token: "gho-fresh",
        scopes: %w[repo read:user],
        last_refresh: Time.current
      )
      duplicate_secret = wrap(duplicate)
      grant = Grant.create!(
        principal: principals(:acme_user_alice),
        static_secret: duplicate_secret,
        created_by: users(:acme_admin)
      )

      survivor = DuplicateCredentialMerge.new.call(duplicate: duplicate, subject: "99123")

      assert_equal canonical.id, survivor.id
      assert_equal 1, BrokerCredential.where(oauth_app: @app).count
      canonical.reload
      assert_equal "gho-fresh", canonical.access_token
      assert_equal %w[repo read:user], canonical.scopes
      assert_equal "ghr-old", canonical.refresh_token, "a consent without a refresh token keeps the old one"
      assert_not canonical.dead?
      assert_nil canonical.dead_reason
      assert_equal 0, canonical.failure_count
      assert_not StaticSecret.exists?(duplicate_secret.id)
      assert_not Grant.exists?(grant.id)
      assert StaticSecret.exists?(canonical_secret.id)
    end

    test "keeps the canonical refresh token replaced when the duplicate carries one" do
      canonical = credential(
        subject: "99123",
        foreign_id: "github-github-99123",
        refresh_token: "ghr-old",
        last_refresh: 2.hours.ago
      )
      wrap(canonical)
      duplicate = credential(
        subject: "pending-abc123",
        foreign_id: "github-github-pending-abc123",
        refresh_token: "ghr-fresh"
      )
      wrap(duplicate)

      DuplicateCredentialMerge.new.call(duplicate: duplicate, subject: "99123")

      assert_equal "ghr-fresh", canonical.reload.refresh_token
    end

    test "an out-of-order enrichment does not clobber a newer token" do
      canonical = credential(
        subject: "99123",
        foreign_id: "github-github-99123",
        access_token: "gho-newer",
        scopes: %w[repo read:user],
        last_refresh: Time.current
      )
      wrap(canonical)
      duplicate = credential(
        subject: "pending-abc123",
        foreign_id: "github-github-pending-abc123",
        access_token: "gho-older",
        scopes: %w[repo],
        last_refresh: 1.hour.ago
      )
      duplicate_secret = wrap(duplicate)

      DuplicateCredentialMerge.new.call(duplicate: duplicate, subject: "99123")

      canonical.reload
      assert_equal "gho-newer", canonical.access_token
      assert_equal %w[repo read:user], canonical.scopes
      assert_not BrokerCredential.exists?(duplicate.id)
      assert_not StaticSecret.exists?(duplicate_secret.id)
    end

    test "ignores a credential of another oauth app that shares the subject" do
      other_app = oauth_apps(:acme_linear)
      other_app.update!(client_secret: "linear-secret")
      BrokerCredential.create!(
        foreign_id: "linear-linear-99123",
        name: "Linear – 99123",
        token_endpoint: Oauth::Providers::Linear::TOKEN_ENDPOINT,
        oauth_app: other_app,
        provider_subject: "99123",
        access_token: "lin-token"
      )
      pending = credential(subject: "pending-abc123", foreign_id: "github-github-pending-abc123")

      assert_nil DuplicateCredentialMerge.new.call(duplicate: pending, subject: "99123")
    end
  end
end
