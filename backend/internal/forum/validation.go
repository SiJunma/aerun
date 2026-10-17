package forum

import (
	"errors"
	"strings"
	"unicode/utf8"
)

var (
	ErrTopicTitleRequired              = errors.New("topic title is required")
	ErrTopicTitleTooLong               = errors.New("topic title must not exceed 256 characters")
	ErrPostContentRequired             = errors.New("post content is required")
	ErrPostContentTooLong              = errors.New("post content must not exceed 65536 characters")
	ErrCategoryIDRequired              = errors.New("category_id is required")
	ErrReputationSelfVote              = errors.New("cannot vote for yourself")
	ErrReputationInvalidValue          = errors.New("reputation value must be 1 or -1")
	ErrReputationCommentTooLong        = errors.New("reputation comment must not exceed 1024 characters")
	ErrReputationVoterOrTargetRequired = errors.New("voter and target are required")
	ErrGuestNicknameRequired           = errors.New("guest nickname is required")
	ErrGuestNicknameTooLong            = errors.New("guest nickname must not exceed 64 characters")
)

// ValidateReputationVote validates voter vs target, vote value and comment length.
func ValidateReputationVote(voterID, targetID string, value int, comment string) (int, string, error) {
	if voterID == "" {
		return 0, "", ErrReputationVoterOrTargetRequired
	}
	if voterID == targetID {
		return 0, "", ErrReputationSelfVote
	}
	if value != 1 && value != -1 {
		return 0, "", ErrReputationInvalidValue
	}
	trimmedComment := strings.TrimSpace(comment)
	if utf8.RuneCountInString(trimmedComment) > MaxReputationCommentLen {
		return 0, "", ErrReputationCommentTooLong
	}
	return value, trimmedComment, nil
}

// ValidateTopicTitle validates title length and presence.
func ValidateTopicTitle(title string) (string, error) {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		return "", ErrTopicTitleRequired
	}
	if utf8.RuneCountInString(trimmed) > MaxTopicTitleLen {
		return "", ErrTopicTitleTooLong
	}
	return trimmed, nil
}

// ValidatePostContent validates content length and presence.
func ValidatePostContent(content string) (string, error) {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return "", ErrPostContentRequired
	}
	if utf8.RuneCountInString(trimmed) > MaxPostContentLen {
		return "", ErrPostContentTooLong
	}
	return trimmed, nil
}

// ValidateGuestNickname validates a guest's display name.
func ValidateGuestNickname(nickname string) (string, error) {
	trimmed := strings.TrimSpace(nickname)
	if trimmed == "" {
		return "", ErrGuestNicknameRequired
	}
	if utf8.RuneCountInString(trimmed) > MaxGuestNicknameLen {
		return "", ErrGuestNicknameTooLong
	}
	return trimmed, nil
}

// ClampLimit enforces page size bounds between 1 and MaxPageLimit.
func ClampLimit(limit, defaultLimit int) int {
	if limit <= 0 {
		if defaultLimit <= 0 {
			return DefaultPageLimit
		}
		return defaultLimit
	}
	if limit > MaxPageLimit {
		return MaxPageLimit
	}
	return limit
}
