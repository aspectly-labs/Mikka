/** The stream id of a stored eve turn (ChatItem.streamId); a live reply keys by it so its row survives the commit. */
export const eveStreamId = (sessionId:string,turnId:string) => `eve:${sessionId}:${turnId}`
