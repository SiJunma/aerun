package forum

// Bounds and rules for the forum domain.
const (
	MinTopicTitleLen        = 1
	MaxTopicTitleLen        = 256
	MinPostContentLen       = 1
	MaxPostContentLen       = 65536
	MaxPostsPerTopic        = 5000
	DefaultPageLimit        = 20
	MaxPageLimit            = 100
	MaxReputationCommentLen = 1024
	MinReputationValue      = -1
	MaxReputationValue      = 1
)
