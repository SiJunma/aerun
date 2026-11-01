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
	MaxGuestNicknameLen     = 64
	// MaxTopicDescriptionLen is the topic's optional short subtitle. Both
	// client forms (TopicFormPage LIMITS.description and the first-post
	// editor's maxLength) already cap it at 200 — this is the server's copy
	// of the same bound.
	MaxTopicDescriptionLen = 200
)
