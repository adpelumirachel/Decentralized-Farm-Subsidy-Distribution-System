;; ClaimProcessor.clar - Core contract for processing farm subsidy claims on Stacks blockchain
;; Orchestrates subsidy claims by verifying eligibility, processing payouts, and logging actions.
;; Interacts with farmer-registry, eligibility-verifier, subsidy-pool, and audit-logger contracts.

;; Constants for error codes
(define-constant ERR_NOT_AUTHORIZED u100)
(define-constant ERR_ALREADY_CLAIMED u101)
(define-constant ERR_INVALID_FARMER u102)
(define-constant ERR_VERIFICATION_FAILED u103)
(define-constant ERR_INSUFFICIENT_FUNDS u104)
(define-constant ERR_INVALID_AMOUNT u105)
(define-constant ERR_CLAIM_PERIOD_EXPIRED u106)
(define-constant ERR_INVALID_CLAIM_ID u107)
(define-constant ERR_CONTRACT_PAUSED u108)
(define-constant ERR_INVALID_METADATA u109)
(define-constant ERR_BLACKLISTED_FARMER u110)
(define-constant ERR_MAX_CLAIMS_REACHED u111)
(define-constant ERR_INVALID_PROOF u112)
(define-constant ERR_INVALID_ADMIN u113)

;; Constants for system parameters
(define-constant MAX_CLAIM_AMOUNT u1000000) ;; Max subsidy amount per claim (micro-STX)
(define-constant CLAIM_COOLDOWN u144) ;; Cooldown period in blocks (~1 day)
(define-constant MAX_CLAIMS_PER_FARMER u5) ;; Max claims per farmer per period
(define-constant MAX_METADATA_LEN u500) ;; Max metadata length
(define-constant MIN_PERIOD u202300) ;; Minimum valid period (e.g., Q1 2023)
(define-constant MAX_PERIOD u210000) ;; Maximum valid period (e.g., Q4 2100)

;; Data variables
(define-data-var claim-counter uint u0)
(define-data-var contract-paused bool false)
(define-data-var admin principal tx-sender)
(define-data-var total-claims-processed uint u0)
(define-data-var total-subsidies-disbursed uint u0)

;; Maps for storage
(define-map Claims
    { claim-id: uint }
    {
        farmer-id: principal,
        status: (string-ascii 20), ;; "pending", "approved", "rejected"
        amount: uint,
        timestamp: uint,
        period: uint,
        metadata: (buff 500),
        verifier-notes: (optional (string-utf8 200))
    }
)

(define-map FarmerClaims
    { farmer-id: principal, period: uint }
    {
        last-claim-block: uint,
        claim-count: uint,
        total-amount: uint,
        blacklisted: bool
    }
)

(define-map ClaimProofs
    { claim-id: uint }
    {
        proof-hash: (buff 32),
        verified: bool
    }
)

;; Traits for external contracts
(define-trait farmer-registry-trait
    (
        (get-farmer-data (principal) (response { land-size: uint, crop-yield: uint, location: (string-ascii 50) } uint))
        (is-registered (principal) (response bool uint))
    )
)

(define-trait eligibility-verifier-trait
    (
        (verify-eligibility (principal uint) (response bool uint))
    )
)

(define-trait subsidy-pool-trait
    (
        (get-pool-balance () (response uint uint))
        (disburse (principal uint) (response bool uint))
    )
)

(define-trait audit-logger-trait
    (
        (log-event (principal (string-ascii 50) uint (optional (buff 500))) (response bool uint))
    )
)

;; External contract references (use deployer-qualified names for Clarinet)
(define-constant farmer-registry-contract 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.farmer-registry)
(define-constant eligibility-verifier-contract 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.eligibility-verifier)
(define-constant subsidy-pool-contract 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.subsidy-pool)
(define-constant audit-logger-contract 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.audit-logger)

;; Private functions
(define-private (is-admin (caller principal))
    (is-eq caller (var-get admin))
)

(define-private (check-cooldown (farmer principal) (period uint))
    (let ((farmer-data (map-get? FarmerClaims { farmer-id: farmer, period: period })))
        (if (is-some farmer-data)
            (let ((data (unwrap! farmer-data (err ERR_INVALID_FARMER))))
                (and
                    (not (get blacklisted data))
                    (< (+ (get last-claim-block data) CLAIM_COOLDOWN) block-height)
                    (< (get claim-count data) MAX_CLAIMS_PER_FARMER)
                )
            )
            true
        )
    )
)

(define-private (update-farmer-claims (farmer principal) (period uint) (amount uint))
    (let ((existing (map-get? FarmerClaims { farmer-id: farmer, period: period })))
        (if (is-some existing)
            (let ((data (unwrap! existing (err ERR_INVALID_FARMER))))
                (map-set FarmerClaims
                    { farmer-id: farmer, period: period }
                    {
                        last-claim-block: block-height,
                        claim-count: (+ (get claim-count data) u1),
                        total-amount: (+ (get total-amount data) amount),
                        blacklisted: (get blacklisted data)
                    }
                )
            )
            (map-set FarmerClaims
                { farmer-id: farmer, period: period }
                {
                    last-claim-block: block-height,
                    claim-count: u1,
                    total-amount: amount,
                    blacklisted: false
                }
            )
        )
    )
)

(define-private (log-claim-event (claim-id uint) (status (string-ascii 20)) (farmer principal) (amount uint))
    (contract-call? audit-logger-contract log-event
        farmer
        status
        amount
        (some (to-buff! { claim-id: claim-id }))
    )
)

;; Public functions
(define-public (submit-claim (amount uint) (period uint) (metadata (buff 500)) (proof-hash (buff 32)))
    (let
        (
            (farmer tx-sender)
            (claim-id (+ (var-get claim-counter) u1))
        )
        (asserts! (not (var-get contract-paused)) (err ERR_CONTRACT_PAUSED))
        (asserts! (> amount u0) (err ERR_INVALID_AMOUNT))
        (asserts! (<= amount MAX_CLAIM_AMOUNT) (err ERR_INVALID_AMOUNT))
        (asserts! (<= (len metadata) MAX_METADATA_LEN) (err ERR_INVALID_METADATA))
        (asserts! (and (>= period MIN_PERIOD) (<= period MAX_PERIOD)) (err ERR_CLAIM_PERIOD_EXPIRED))
        (asserts! (check-cooldown farmer period) (err ERR_ALREADY_CLAIMED))
        (asserts! (len proof-hash) (err ERR_INVALID_PROOF))
        (match (contract-call? farmer-registry-contract is-registered farmer)
            success (asserts! success (err ERR_INVALID_FARMER))
            error (err error)
        )
        (map-set Claims
            { claim-id: claim-id }
            {
                farmer-id: farmer,
                status: "pending",
                amount: amount,
                timestamp: block-height,
                period: period,
                metadata: metadata,
                verifier-notes: none
            }
        )
        (map-set ClaimProofs
            { claim-id: claim-id }
            { proof-hash: proof-hash, verified: false }
        )
        (var-set claim-counter claim-id)
        (try! (log-claim-event claim-id "submitted" farmer amount))
        (ok claim-id)
    )
)

(define-public (process-claim (claim-id uint) (verifier-notes (string-utf8 200)))
    (let
        (
            (claim (map-get? Claims { claim-id: claim-id }))
            (proof (map-get? ClaimProofs { claim-id: claim-id }))
        )
        (asserts! (is-some claim) (err ERR_INVALID_CLAIM_ID))
        (asserts! (is-some proof) (err ERR_INVALID_PROOF))
        (let
            (
                (claim-data (unwrap! claim (err ERR_INVALID_CLAIM_ID)))
                (proof-data (unwrap! proof (err ERR_INVALID_PROOF)))
                (farmer (get farmer-id claim-data))
                (period (get period claim-data))
                (amount (get amount claim-data))
            )
            (asserts! (is-eq (get status claim-data) "pending") (err ERR_ALREADY_CLAIMED))
            (asserts! (is-admin tx-sender) (err ERR_NOT_AUTHORIZED))
            (asserts! (get verified proof-data) (err ERR_INVALID_PROOF))
            (match (contract-call? eligibility-verifier-contract verify-eligibility farmer period)
                verified (asserts! verified (err ERR_VERIFICATION_FAILED))
                error (err error)
            )
            (match (contract-call? subsidy-pool-contract get-pool-balance)
                balance (asserts! (>= balance amount) (err ERR_INSUFFICIENT_FUNDS))
                error (err error)
            )
            (match (contract-call? subsidy-pool-contract disburse farmer amount)
                success (asserts! success (err ERR_VERIFICATION_FAILED))
                error (err error)
            )
            (map-set Claims
                { claim-id: claim-id }
                (merge claim-data { status: "approved", verifier-notes: (some verifier-notes) })
            )
            (update-farmer-claims farmer period amount)
            (var-set total-claims-processed (+ (var-get total-claims-processed) u1))
            (var-set total-subsidies-disbursed (+ (var-get total-subsidies-disbursed) amount))
            (try! (log-claim-event claim-id "approved" farmer amount))
            (ok true)
        )
    )
)

(define-public (reject-claim (claim-id uint) (reason (string-utf8 200)))
    (let ((claim (map-get? Claims { claim-id: claim-id })))
        (asserts! (is-some claim) (err ERR_INVALID_CLAIM_ID))
        (let ((claim-data (unwrap! claim (err ERR_INVALID_CLAIM_ID))))
            (asserts! (is-eq (get status claim-data) "pending") (err ERR_ALREADY_CLAIMED))
            (asserts! (is-admin tx-sender) (err ERR_NOT_AUTHORIZED))
            (map-set Claims
                { claim-id: claim-id }
                (merge claim-data { status: "rejected", verifier-notes: (some reason) })
            )
            (try! (log-claim-event claim-id "rejected" (get farmer-id claim-data) (get amount claim-data)))
            (ok true)
        )
    )
)

(define-public (verify-proof (claim-id uint) (is-valid bool))
    (let ((proof (map-get? ClaimProofs { claim-id: claim-id })))
        (asserts! (is-some proof) (err ERR_INVALID_CLAIM_ID))
        (asserts! (is-admin tx-sender) (err ERR_NOT_AUTHORIZED))
        (map-set ClaimProofs
            { claim-id: claim-id }
            (merge (unwrap! proof (err ERR_INVALID_PROOF)) { verified: is-valid })
        )
        (ok true)
    )
)

(define-public (blacklist-farmer (farmer principal) (period uint))
    (asserts! (is-admin tx-sender) (err ERR_NOT_AUTHORIZED))
    (asserts! (and (>= period MIN_PERIOD) (<= period MAX_PERIOD)) (err ERR_CLAIM_PERIOD_EXPIRED))
    (let ((existing (map-get? FarmerClaims { farmer-id: farmer, period: period })))
        (if (is-some existing)
            (map-set FarmerClaims
                { farmer-id: farmer, period: period }
                (merge (unwrap! existing (err ERR_INVALID_FARMER)) { blacklisted: true })
            )
            (map-set FarmerClaims
                { farmer-id: farmer, period: period }
                { last-claim-block: u0, claim-count: u0, total-amount: u0, blacklisted: true }
            )
        )
        (ok true)
    )
)

(define-public (pause-contract)
    (begin
        (asserts! (is-admin tx-sender) (err ERR_NOT_AUTHORIZED))
        (var-set contract-paused true)
        (ok true)
    )
)

(define-public (unpause-contract)
    (begin
        (asserts! (is-admin tx-sender) (err ERR_NOT_AUTHORIZED))
        (var-set contract-paused false)
        (ok true)
    )
)

(define-public (set-admin (new-admin principal))
    (begin
        (asserts! (is-admin tx-sender) (err ERR_NOT_AUTHORIZED))
        (asserts! (not (is-eq new-admin 'ST000000000000000000002AMW42H)) (err ERR_INVALID_ADMIN)) ;; Prevent null principal
        (var-set admin new-admin)
        (ok true)
    )
)

;; Read-only functions
(define-read-only (get-claim-details (claim-id uint))
    (map-get? Claims { claim-id: claim-id })
)

(define-read-only (get-farmer-claim-history (farmer principal) (period uint))
    (map-get? FarmerClaims { farmer-id: farmer, period: period })
)

(define-read-only (get-claim-proof (claim-id uint))
    (map-get? ClaimProofs { claim-id: claim-id })
)

(define-read-only (get-total-claims)
    (ok (var-get total-claims-processed))
)

(define-read-only (get-total-disbursed)
    (ok (var-get total-subsidies-disbursed))
)

(define-read-only (is-contract-paused)
    (ok (var-get contract-paused))
)

(define-read-only (get-admin)
    (ok (var-get admin))
)

(define-read-only (can-claim (farmer principal) (period uint))
    (ok (check-cooldown farmer period))
)