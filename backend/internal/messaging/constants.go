package messaging

// Bounds and rules for direct messaging, notifications and outbox.
const (
	MinDMMessageLen   = 1
	MaxDMMessageLen   = 65536
	MaxDMTitleLen     = 256
	MaxDMParticipants = 50
	MaxOutboxAttempts = 5
	DefaultPageLimit  = 20
	MaxPageLimit      = 100
)
