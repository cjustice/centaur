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

      # Read both before the destroy, so the log never depends on what an
      # already-destroyed record can still answer.
      duplicate_oid = duplicate.oid
      provider = duplicate.oauth_app.provider
      BrokerCredential.transaction do
        # The consents can enrich out of order (a double-submitted first
        # connect), so only the newer token wins; either way the duplicate goes.
        canonical.update!(rotating_attributes(duplicate, canonical)) if token_newer?(duplicate, canonical)
        # Every principal that reached the account through the duplicate has to
        # keep reaching it through the survivor, so move the grants before the
        # wrapper that owns them is destroyed.
        transfer_grants(duplicate.static_secret, canonical.static_secret)
        # The wrapper owns the token_broker source that BrokerCredential's
        # before_destroy guard refuses to orphan, so it has to go first. Any
        # grants left on it go with it (StaticSecret dependent: :destroy).
        duplicate.static_secret&.destroy!
        duplicate.destroy!
      end

      Rails.logger.info do
        "#{provider} oauth credential identity enrichment merged duplicate: " \
          "duplicate=#{duplicate_oid} credential=#{canonical.oid}"
      end
      canonical
    end

    private

    # Re-running reconciliation would not do this: it grants by *matching* the
    # credential, so it cannot reconstruct a grant an operator made by hand, and
    # it skips a principal that matched the duplicate's owner but not the
    # survivor's. Carrying the rows over keeps every principal's access exactly
    # as it was, which is the whole point of merging rather than deleting.
    def transfer_grants(from, to)
      return if from.nil? || to.nil?

      from.grants.each do |grant|
        next if to.grants.exists?(principal_id: grant.principal_id)

        to.grants.create!(principal_id: grant.principal_id, created_by: grant.created_by)
      end
    end

    # At most one row can match: a unique index covers (oauth_app_id,
    # provider_subject) wherever provider_subject is not null. The blank guard
    # keeps that true -- querying a null subject would match every credential
    # the index excludes, and destroy one of them.
    def canonical_for(duplicate, subject)
      return nil if subject.blank?

      BrokerCredential
        .where(oauth_app_id: duplicate.oauth_app_id, provider_subject: subject)
        .where.not(id: duplicate.id)
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
