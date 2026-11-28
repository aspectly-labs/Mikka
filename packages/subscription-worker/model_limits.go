package worker

// Hosted model requests retain the full bounded prompt. The 100k-token
// conversation compaction estimate can allow ~400k UTF-8 bytes before system
// instructions and tool schemas, so 512 KiB is insufficient for that budget.
// The native broker accepts the model gateway's separate request budget.
const (
	modelRequestMaxBytes          = 1 << 20
	modelConvertedRequestMaxBytes = 2 << 20
	modelRPCFrameMaxBytes         = 2 << 20
	nativeRequestMaxBytes         = 16 << 20
	nativeRPCFrameMaxBytes        = nativeRequestMaxBytes + (128 << 10)
	// Frame budgets exclude LF. The old 512 KiB Scanner buffer included it.
	legacyRPCFrameMaxBytes = (512 << 10) - 1
)
