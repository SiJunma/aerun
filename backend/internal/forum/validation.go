package forum

import (
	"errors"
	"strings"
	"unicode/utf8"
)

var (
	ErrTopicTitleRequired  = errors.New("topic title is required")
	ErrTopicTitleTooLong   = errors.New("topic title must not exceed 256 characters")
	ErrPostContentRequired = errors.New("post content is required")
	ErrPostContentTooLong  = errors.New("post content must not exceed 65536 characters")
	ErrCategoryIDRequired  = errors.New("category_id is required")
)

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
