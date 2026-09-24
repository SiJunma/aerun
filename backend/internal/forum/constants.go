package forum

// Bounds and rules for the forum domain.
const (
	MinTopicTitleLen  = 1
	MaxTopicTitleLen  = 256
	MinPostContentLen = 1
	MaxPostContentLen = 65536
	MaxPostsPerTopic  = 5000
	DefaultPageLimit  = 20
	MaxPageLimit      = 100
)
