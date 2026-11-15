# Retry implementation

The active discussion retains its latest failed worker attempt in memory across Reload. Retrying queues the original instruction ahead of later queued work, with the failure and commits since the failure in the worker's briefing. The existing lane recovery checks remain in force. Retry with uses the Worker settings save path.

A relayed worker failure is added to the discussion without starting a round. The same auto dev run resumes only when its retry succeeds while that run is still in its failure pause. A retry result is still reported if that run was restarted or finished while it ran.

If a worker fails while a discussion turn is in progress, the failure is shown immediately and added to the agents' transcript between input turns. This prevents an agent already thinking from marking the failure as seen before it receives it.
