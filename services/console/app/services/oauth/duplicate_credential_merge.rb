module Oauth
  # Folds a duplicate OAuth credential into the one that already represents the
  # same provider account.
  #
  # Providers that withhold account identity at the token endpoint (github,
  # attio, linear) get a pending provider_subject derived from the freshly
  # issued access token, so a repeat consent for an already-connected account
  # never matches the existing row in Oauth::FlowsController#upsert_credential
  # and mints a second credential. The enrichment job resolves the real subject
  # afterwards and would then collide with the first credential's foreign_id
  # (and the unique (oauth_app_id, provider_subject) index), leaving a stray
  # credential stuck under its pending name with a live token and a competing
  # wrapper secret.
  #
  # Running this before the job's own update! makes those providers behave like
  # the ones that do return identity at the callback: one credential per
  # (app, provider account), carrying the newest token, keeping the operator who
  # first linked it.
  class DuplicateCredentialMerge
    # Returns the surviving credential when +duplicate+ was merged away, or nil
    # when +subject+ has no other credential and the caller should enrich
    # +duplicate+ in place.
    def call(duplicate:, subject:)
      canonical = canonical_for(duplicate, subject)
      return nil if canonical.nil?

      BrokerCredential.transaction do
        # The consents can enrich out of order (a double-submitted first
        # connect), so only the newer token wins; either way the duplicate goes.
        canonical.update!(rotating_attributes(duplicate, canonical)) if token_newer?(duplicate, canonical)
        # The wrapper owns the token_broker source that BrokerCredential's
        # before_destroy guard refuses to orphan, so it has to go first. Its
        # auto-created grants go with it (StaticSecret dependent: :destroy).
        duplicate.static_secret&.destroy!
        duplicate.destroy!
      end

      # update! re-fires auto_grant_matching_principals, so the surviving
      # wrapper is re-granted to every principal that matches the account before
      # the duplicate's own grants are dropped.
      canonical
    end

    private

    # At most one row can match: a unique partial index covers
    # (oauth_app_id, provider_subject).
    def canonical_for(duplicate, subject)
      return nil if subject.blank?

      BrokerCredential
        .where(oauth_app_id: duplicate.oauth_app_id, provider_subject: subject)
        .where.not(id: duplicate.id)
        .order(:id)
        .first
    end

    def rotating_attributes(duplicate, canonical)
      {
        access_token: duplicate.access_token,
        # A consent that returns no refresh token must not drop the one the
        # survivor already refreshes with.
        refresh_token: duplicate.refresh_token.presence || canonical.refresh_token,
        scopes: duplicate.scopes,
        expires_at: duplicate.expires_at,
        last_refresh: duplicate.last_refresh,
        next_attempt_at: duplicate.next_attempt_at,
        # The fresh consent revives a credential the operator had to reconnect.
        failure_count: 0,
        dead: false,
        dead_reason: nil
      }
    end

    def token_newer?(duplicate, canonical)
      return false if duplicate.last_refresh.blank?
      return true if canonical.last_refresh.blank?

      duplicate.last_refresh >= canonical.last_refresh
    end
  end
end
