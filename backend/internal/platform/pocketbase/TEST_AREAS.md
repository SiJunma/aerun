# Go tests in `internal/platform/pocketbase`: areas and how to run them

The package holds ~448 tests (2026-11-19). A full run takes ~14.5 minutes
(measured 863.8 s): every test boots its own PocketBase app with migrations
and seed fixtures, ~1–2 s each. There is no single slow test and no hang —
splitting by a `slow` build tag or `testing.Short()` buys nothing, because the
cost is spread evenly over all tests.

## Why a full run looks hung

Without `-v`, `go test` prints nothing until the whole package finishes — 14
minutes of silence. That is the "hang". Always run with `-v` so test names
stream as they start, and run the full suite in the background (or as the
final gate before deploy), never as a foreground step the agent watches.

## Run one area, not the whole package

`go test -run '<pattern>' -v -count=1 ./internal/platform/pocketbase/`

`-run` takes a regexp matched against test names (unanchored). `-count=1`
disables the result cache. Patterns overlap a little — that is harmless.

| Area | `-run` pattern | ~tests | ~time |
|---|---|---|---|
| Forum index / categories | `TestCategor\|TestForumIndex\|TestMainPage\|TestListCategor\|TestForumStats\|TestCanViewCategor\|TestListTopics\|TestListPosts\|TestGetPost\|TestDefaultTopicReply` | 23 | ~45 s |
| Topics / posts / drafts | `TestTopic\|TestPost\|TestCreate\|TestEdit\|TestDraft\|TestReply\|TestGoLast\|TestJump\|TestQuote\|TestPin\|TestMove\|TestRolls\|TestDeletePost\|TestDeleteTopic\|TestDeletedPost\|TestDeletedAuthor\|TestMovingTheOpening\|TestUpdateTopic\|TestUnpinned\|TestStrangerMayNotDelete\|TestListPostsLocate` | 62 | ~2 min |
| Masks / characters / DTO | `TestMask\|TestCharacter\|TestNestedAuthor\|TestDeletedAccount\|TestFrozen\|TestBaking\|TestApplyLastPost\|TestVerifyAuthorRef\|TestUnusedMask\|TestStoredMask\|TestDisabledCharacter\|TestEveryoneCanReadSuspended` | 22 | ~40 s |
| Profile / users / counters | `TestProfile\|TestUser\|TestAvatar\|TestMember\|TestNickname\|TestRecompute\|TestUploadMyAvatar\|TestUploadIdentity\|TestMigratedUsers\|TestLastSeen\|TestCounter\|TestPurge\|TestRebuildTopic` | 54 | ~1.7 min |
| Realtime / unread / presence | `TestRealtime\|TestUnread\|TestPresence\|TestSignal\|TestMark\|TestDispatch\|TestOutbox\|TestOnline\|TestDaily\|TestEvictOnline\|TestRegistrationPublishesPresence` | 28 | ~55 s |
| Admin / audit / roles | `TestAdmin\|TestAudit\|TestRole\|TestStaff\|TestRoot\|TestHard\|TestSprint4Admin\|TestDeleteRole\|TestReservedRole\|TestOmittedRole\|TestNewRole\|TestInheritMarker\|TestMeMatrix\|TestMeRejects\|TestEveryDeleteIsAudited` | 51 | ~1.6 min |
| Auth / guests / identity | `TestAuth\|TestGuest\|TestRegister\|TestSign\|TestIdentity\|TestPublic\|TestPending\|TestBanned\|TestUnverified\|TestInbox\|TestPeer\|TestTransfer\|TestUnlink\|TestSelfRename\|TestResetIdentity\|TestResolveRequestID\|TestInitialAccount\|TestLockedMutations\|TestSuspended\|TestSoftDeleted\|TestLoggedInMember\|TestSecureRead\|TestRunRejects\|TestErrorContract` | 84 | ~2.7 min |
| DM / conversations | `TestDM\|TestDm\|TestConversation\|TestFindConversation\|TestListDM\|TestEraseWithDeletedPeer\|TestDeletedDM\|TestClearedConversation\|TestDMCollector\|TestSprint5DM\|TestSprint5ConcurrentDM` | 26 | ~50 s |
| Mentions / mail / notifications | `TestMention\|TestMail\|TestEmail\|TestRenderEmail\|TestResend\|TestSanitizeMail\|TestSprint5Notif\|TestSprint5Outbox\|TestSprint5AdminOutbox` | 17 | ~30 s |
| Votes / reputation | `TestVote\|TestReputation\|TestSprint4Reputation\|TestSprint4ConcurrentVotes\|TestSprint4Subscriptions\|TestSprint4Privacy\|TestSprint4DoD\|Test100Concurrent\|TestUpsertTopicRead\|TestConcurrent\|TestCountMethodsIsPostRemoval\|TestMyVotesAreServable` | 7 | ~15 s |
| Import | `TestImport` | 41 | ~1.3 min |
| Settings / config / misc | `TestConfigure\|TestSettings\|TestVerify\|TestLoad\|TestSystem\|TestUpdateGlobal\|TestGetGlobal\|TestChangeEmail\|TestChangePassword\|TestMasterDice\|TestExtractBody\|TestWrapWithGlobal\|TestAerunWrap\|TestCatalogAndBootstrap\|TestIdempotencyPruneCron` | 32 | ~1 min |

## Rules

- Day-to-day: run the area the change touches (plus the neighbouring area
  when the change crosses a boundary, e.g. DTO changes touch
  masks/characters AND topics/posts AND forum-index).
- Before deploy: the full package once, with `-v`, in the background.
  `go vet ./internal/platform/pocketbase/` and `go build ./...` are the fast
  gates and run first.

## Why not split the package

A real split into subpackages is a large refactor, not a quick win: the tests
share helpers (`newAerunTestApp`, `seedIdentityFixtures`, `newTestServer`,
…) in this package, and they test unexported code (`decoratePostAuthor`,
`applyMask`, `categoryForumProjections`, …), which a subpackage cannot reach.
Splitting the tests would mean moving production code into subpackages first.
The `-run` areas above give most of the benefit with no refactor.
