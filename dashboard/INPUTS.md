# What the dashboard reads

The dashboard runs inside the validator. It reads only what the validator already has. This document lists those inputs. For each input it gives the source, how the dashboard reads it, and the part of the page that uses it. It is for anyone who decides what a validator must expose to tools such as this one.

There are six kinds of input. The table ranks them from the most fragile to the least fragile.

| Kind | How the dashboard reads it | Event shaped | What can break it |
| --- | --- | --- | --- |
| Metrics datapoints | An observer sees each datapoint before the validator sends it, and keeps the ones named below | Nearly | A renamed point or field; a point that needs a higher log level |
| Frozen banks | A channel that replay writes to, named in the validator config | Yes | Nothing |
| Gossip and bank forks before the wait | One message on a channel named in the config, sent before the supermajority wait | Yes | Nothing |
| Bank and bank forks reads | Polled every 200 ms and every second | No | Lock contention; a bank pruned before the read |
| Gossip, blockstore, caches | Direct calls on handles the run command passes | No | API changes between releases |
| The host | `/proc`, `statvfs`, and the validator's own threads | Not the validator's to emit | Linux only |

## Metrics datapoints

The validator reports on itself with `solana_metrics` datapoints. The dashboard installs an observer when it starts. The observer matches each point by name, then by field name, and keeps the fields it needs. Each row below gives one point, the fields the dashboard reads, and the part of the page they feed. The dashboard ignores all other fields. If the validator stops sending a point, the figures that use it stop without an error.

### Per slot

Each of these points carries a slot and describes one block.

| Point | Fields read | Feeds |
| --- | --- | --- |
| `replay-slot-stats` | `slot`, `fetch_entries_time`, `confirmation_without_replay_us` or `confirmation_time_us`, `bank_complete_time_us`, `entry_poh_verification_time`, `entry_transaction_verification_time`, `task_submission_us` or `replay_time`, `execute_us`, `execute_details_execute_inner_us`, `execute_details_serialize_us`, `execute_details_deserialize_us`, `execute_details_create_vm_us`, `execute_details_create_executor_load_elf_us`, `execute_details_create_executor_verify_code_us`, `execute_details_create_executor_jit_compile_us`, `load_us`, `store_us`, `program_cache_us`, `validate_transactions_us`, `validate_fees_us`, `filter_executable_us`, `collect_balances_us`, `collect_logs_us`, `update_stakes_cache_us`, `update_transaction_statuses`, `check_block_limits_us`, `total_transactions` | The replay card: time per slot, its three spans, and the verify and execute breakdowns. The schedule page's replay column and its received to replayed timeline. |
| `shred_insert_is_full` | `slot`, `last_index`, `num_repaired`, `total_time_ms` | Shreds and repaired shreds per slot. The first shred to full block span on the timeline. |
| `retransmit-stage-slot-stats` | `num_shreds_received_root`, `num_shreds_received_1st_layer`, `num_shreds_received_2nd_layer`, `num_shreds_received_3rd_layer` | Network card: shreds by the turbine layer they arrived from, over five minutes |
| `cost_tracker_stats` | tag `is_leader`; `bank_slot`, `block_cost`, `costliest_account`, `costliest_account_cost`, `number_of_accounts`, `number_of_contended_accounts`, `allocated_accounts_data_size`, `inflight_transaction_count` | Slot details for our own blocks: compute used, and the costliest account against its own limit. Points without the leader tag are dropped. |
| `banking_stage_scheduler_slot_counts` | `slot` and the scheduler counters listed under per second | Slot details: the waterfall for one of our own leader slots |
| `bundle_stage-stats` (jito only) | `slot`, `num_sanitized_ok`, `execution_results_ok` | Bundles sanitised and landed per produced block |
| `banking_stage_worker_timing` | tag `id`; `cost_model_us`, `load_execute_us`, `load_execute_us_max`, `freeze_lock_us`, `record_us`, `commit_us`, `find_and_send_votes_us` | Execution time on a produced block: the reports that arrived between the block's first shred and its last, summed across the workers |
| `banking_stage-leader_slot_vote_execute_and_commit_timings` | `slot`, `load_execute_us`, `freeze_lock_us`, `record_us`, `commit_us`, `find_and_send_votes_us` | The vote worker's part of the same figure |
| `event_handler_slot_tracking` | `slot`, `first_shred`, `parent_ready`, `vote_notarize`, `vote_skip` | When this node's vote for a slot went out, after the first shred or the parent becoming ready, on the list of unrewarded votes (alpenglow only). The first shred is reported for the first slot of a leader window only. |

### Per second

These points are running counters. The dashboard subtracts the previous reading once a second.

| Point | Fields read | Feeds |
| --- | --- | --- |
| `shred_fetch_receiver`, `shred_fetch_repair_receiver` | `packets_count` | Repaired shreds on the status card. The turbine row of the socket card. |
| `retransmit-stage` | tag `is_xdp`; `num_shreds_dropped_xdp_full` | Network card: shreds dropped because the XDP channel was full, beside the XDP line |
| `gossip_receiver`, `tpu_vote_receiver` | `packets_count` | Packets delivered on the gossip and UDP vote rows of the socket card |
| `Gossip`, `Repair` (the streamer senders) | `streamer-send-bytes_total`, `streamer-send-sample_duration_ms` | Network card: what the gossip and repair senders put on the wire |
| `banking_stage_scheduler_counts` | tag `id`; `num_received`, `num_dropped_on_receive`, `num_dropped_on_check_work_queue_full`, `num_dropped_on_parsing_and_sanitization`, `num_dropped_on_validate_locks`, `num_dropped_on_receive_compute_budget`, `num_dropped_on_receive_age`, `num_dropped_on_receive_already_processed`, `num_dropped_on_receive_fee_payer`, `num_dropped_on_filter_key`, `num_dropped_on_nonce_dedup`, `num_buffered`, `num_dropped_on_capacity`, `num_evicted_on_nonce_dedup`, `num_dropped_on_clear`, `num_dropped_on_clean`, `num_scheduled`, `num_unschedulable_conflicts`, `num_unschedulable_threads`, `num_finished`, `num_retryable` | The scheduler section of the TPU path card. The `id` tag separates the validator's own scheduler from BAM's. The two count `num_received` in different units. |
| `banking_stage_worker_counts`, `banking_stage_worker_error_metrics` | `transactions_attempted_processing_count`, `cost_model_throttled_transactions_count`, `retryable_transaction_count`, `retryable_expired_bank_count`, `processed_transactions_count`, `processed_with_successful_result_count`, `too_many_account_locks`, `account_not_found`, `insufficient_funds`, `invalid_account_for_fee`, `blockhash_not_found`, `blockhash_too_old`, `already_processed`, `invalid_compute_budget`, `max_loaded_accounts_data_size_exceeded`, `invalid_program_for_execution`, `program_execution_temporarily_restricted` | The executed section of the TPU path card, summed over the epoch |
| `tpu-verifier` | `total_packets`, `total_dedup`, `total_dropped_below_priority_floor`, `total_valid_packets`, `eviction_drops` | The verify section of the TPU path card, summed over the epoch |
| `quic_streamer_tpu`, `quic_streamer_tpu_forwards`, `quic_streamer_tpu_vote` | `total_incoming_connection_attempts`, `connection_rate_limited_across_all`, `connection_rate_limited_per_ipaddr`, `refused_connections_too_many_open_connections`, `connection_setup_timeout`, `connection_setup_error`, `new_connections`, `connection_add_failed`, `connection_add_failed_staked_node`, `connection_add_failed_unstaked_node`, `connection_add_failed_banned`, `connection_added_from_staked_peer`, `connection_added_from_unstaked_peer`, `new_streams`, `throttled_staked_streams`, `throttled_unstaked_streams`, `stream_read_timeouts`, `stream_read_errors`, `invalid_stream_size`, `packets_sent_to_consumer`, `bytes_sent_to_consumer`, `total_handle_chunk_to_packet_send_full_err`, `total_handle_chunk_to_packet_send_disconnected_err`, `open_connections`, `active_streams` | One section per QUIC port on the TPU path card: connections, then streams, then packets. Connection attempts arrive as a running total and are stored, not added. Open connections and active streams are levels and are never summed. |
| `bundle_stage-loop_stats` (jito only) | `num_bundles_received`, `num_packets_received` | The bundles line under the executed section |
| `accounts_db_store_timings` | `total_bytes`, `total_alive_bytes`, `total_count`, `read_only_accounts_cache_data_size`, `read_only_accounts_cache_entries`, `read_only_accounts_cache_hits`, `read_only_accounts_cache_misses`, `read_only_accounts_cache_evicts` | Caches card: storage size, the live share, file count, and the read cache's size and hit rate |
| `accounts_db_load_accounts`, `accounts_db-stores`, `accounts_db-flush_accounts_cache` | `num_loaded_from_write_cache`, `num_loaded_from_read_cache`, `num_loaded_from_index_storage`, `num_accounts_stored`, `account_bytes_stored` (spelled `num_accounts_flushed`, `account_bytes_flushed` on 4.2) | Caches card: where reads were answered from, and what was flushed |
| `loaded-programs-cache-stats` | `hits`, `misses`, `evictions`, `reloads`, `insertions`, `lost_insertions`, `replace_entry`, `one_hit_wonders`, `prunes_orphan`, `prunes_environment`, `empty_entries`, `water_level` | The program cache card. The water level is a level that resets with each bank, so the card shows its peak over the window. |

### Read once, or on change

| Point | Fields read | Feeds |
| --- | --- | --- |
| `xdp-network-config` | tags `driver`, `zero_copy`; `vendor`, `model`, `kernel_version` | Network card: how the XDP transmit path is set up |
| `wfsm_gossip` | `online_stake`, `offline_stake`, `total_activated_stake` | The exact stake figure during the supermajority wait. The validator's own progress value is a whole percent. |

## Frozen banks

Replay sends a notification for each bank it freezes. The dashboard adds a sender to `ValidatorConfig::extra_bank_notification_senders`. A small relay in the validator copies each notification to that sender and to the RPC sender. The dashboard's channel holds 512 notifications, and the relay uses `try_send`, so a stalled dashboard drops notifications instead of holding banks or slowing replay. Jito's tree already has its own fan out for this. There the dashboard's channel takes frozen banks only. The collector drains the channel every 200 ms. It reads each bank once, at freeze, before the validator can prune it.

| Read off the bank | Feeds |
| --- | --- |
| `slot`, `parent_slot` | The key for everything per slot. Counts are the difference from the parent's running totals. |
| `transaction_count`, `non_vote_transaction_count_since_restart` | Transactions and votes per block |
| `transaction_error_count`, `transaction_entries_count` | Failed transactions and entries per block |
| The cost tracker: block cost, block limit, account limit | Compute per block, and the limits it is drawn against |
| Collector fee details: total and priority fees | Base and priority fees per block, and with the tips what the block earned this validator |
| The balance of the eight tip accounts | Tips per block, as the difference from the parent (jito only) |
| `last_blockhash` | The blockhash of our own blocks, on the block panel |

An event with these fields, sent when a block completes, would mean the dashboard never holds a bank.

## Gossip and bank forks before the wait

The supermajority wait runs inside the validator constructor. At that time nothing outside the constructor has handles. So the constructor sends gossip and bank forks down `ValidatorConfig::gossip_ready_sender` just before the wait starts. The dashboard's boot thread then walks the snapshot bank's staked validators against gossip every 250 ms, with the same rule the validator's own check uses. For each validator it publishes the stake, the version, and if gossip has a fresh contact. The same handles let the header show this validator's name during the wait.

The validator's own walk logs a result for each node but emits only totals. If it emitted each node's result, the dashboard would not need its own walk.

## Bank and bank forks reads

The collector thread polls every 200 ms. The meters thread polls once a second. Each holds the bank forks read lock only to clone handles out.

| Call | Feeds |
| --- | --- |
| `BankForks::root_bank`, `working_bank`, `highest_slot`, `frozen_banks` | The slot readouts. Per slot detail where no notification channel is wired. Failed transaction totals for TPS. |
| `BankForks::migration_status`, `Bank::is_alpenglow` | Which consensus the cluster runs, and which of two cluster tip sources to read |
| `Bank::vote_accounts` | Our stake and commission, whether our vote account has a BLS key, and our vote credits this epoch (lamports of reward under alpenglow, in the same field). The validators card's counts and delinquency, and each validator's delinquency and stalest last vote in the certificate lists. The peer table's stake. The wait's validator list. |
| `Bank::get_rank_map` for this epoch and the next, `get_vat_health_for_next_epoch` | Under alpenglow, whether this vote account holds a seat in the admitted set now and next epoch, and how far the vote account is short of the ticket after that. The header's "no seat" figure and the epoch card's stat in place of the vote figure. |
| `Bank::get_lamports_per_signature`, `minimum_vote_account_balance_for_vat`, `get_minimum_balance_for_rent_exemption` | What voting costs: a day of vote fees under TowerBFT, and under alpenglow the admission ticket and the balance the vote account must hold at the epoch's turn. The header's balance warnings. |
| `Bank::epoch_schedule`, `epoch`, `slot`, `block_height`, `ns_per_slot_at_slot` | The epoch card, block height, and the configured slot time |
| `Bank::clock` | The epoch's measured slot rate, for the epoch countdown |
| `Bank::get_rank_map` | This node's rank in the BLS rank map, to find its bit in a certificate |
| `Bank::get_program_accounts_modified_since_parent`, `get_filtered_indexed_accounts`, `account_indexes_include_key` | Validator names and icons from the config program's accounts: once before the wait, once at attach, then as they change |
| `Bank::transaction_count`, `non_vote_transaction_count_since_restart` on the working bank | TPS, as the difference once a second |

## Gossip, blockstore, caches

| Call | Feeds |
| --- | --- |
| `ClusterInfo::all_peers`, `my_shred_version`, `my_contact_info`, `id` | Cluster versions, the RPC node count, the peer table's clients, versions and addresses, our identity and shred version |
| `ClusterInfo::tvu_peers`, with each contact's wallclock | Who counts as seen during the supermajority wait |
| `Blockstore::meta`, `is_full`, `lowest_slot`, `ledger_path` | First shred times for slot durations, skipped slots, the skip rate's window, and which filesystem holds the ledger |
| `Blockstore::get_slot_components_with_shred_info` on a block's last two FEC sets | The block footer's reward certificates, read against the rank map. Under alpenglow, if this node's vote was paid for each slot, and how many slots each rank was paid for this epoch, against which the epoch card measures this vote. The vote account's own figure is lamports there and counts leader slots too, so it cannot be compared across validators. The count starts where the dashboard did, not at the epoch's start. Each unpaid slot is also placed, first match winning: within the epoch's first thousand slots; in one of this node's leader slots; during a snapshot write (a span from the slot replay was at when the staging file was first seen, on the five-second tier, to the slot it was at when the file went); thin, the certificate paying at least a tenth fewer ranks than the median of the epoch's certificates so far, once a hundred are in; late, this node finishing replay of the slot after the first shred of the certificate writer's slot arrived; else lost, with the writers of the lost ones counted from the leader schedule and named from the validator info cache. The thin cutoff and the rank count go out with the counts. On request, each unpaid slot is listed with its writer, the regulars the certificate left out beside this node, and when this node's vote went out. |
| `Blockstore::get_slot_entries` on our own slots, once full | The block's non-vote transactions by message version: legacy, v0, v1 |
| `Blockstore::get_latest_optimistic_slots`, `highest_slot` | The cluster's tip under TowerBFT, for the distance behind it: the last confirmed slot, floored by the highest slot shreds have arrived for, since the confirmed slot predates the snapshot after a restart |
| `BlockCommitmentCache::highest_confirmed_slot`, `highest_super_majority_root`, `root` | The confirmed, rooted and finalized levels on the slot strip |
| `Validator::highest_finalized` | The cluster's tip under alpenglow, from votor's last certificate |
| `LeaderScheduleCache::slot_leader_at`, `get_epoch_leader_schedule` with `get_leader_upcoming_slots`, `next_leader_slot` | The epoch's leader turns, our own leader slots, who is in the peer table, and the countdown to our slot |
| `ValidatorStartProgress` | The boot phase list and its timings |
| The snapshot archive directories, listed through `agave_snapshots::paths`, and the intervals in `SnapshotConfig` | The newest full and incremental archive with the time each was written, and when the next of each is due. An archive being staged, by its temporary file, and how long the last one took |
| `solana_version::Version::this_build` | The client name, version and commit in the header |

The certificate walk is the one place where the dashboard parses ledger bytes. A per slot event that names the validators each reward certificate paid would replace it. The leader already knows this when it writes the footer.

## The host

The validator does not own these inputs. They are here for completeness: `/proc/stat`, `/proc/loadavg`, `/proc/meminfo`, `/proc/diskstats`, `/proc/net/dev`, `/proc/net/udp` and `udp6` for socket drops and queues, `statvfs` on the ledger, accounts and snapshot paths, `/sys/dev/block/<major>:<minor>` to find the disk under each of those paths, `/proc/self/status` for the validator's resident memory, and `/proc/self/task/*` for the validator's own threads. The socket rows need one fact that only the validator has: how many packets each receiver delivered. The kernel counts drops but not deliveries. The delivered count comes from the datapoints above.

## What the dashboard could not read

Some panels were planned and not built. The validator has no input for them.

- A shred timeline. The validator does not record when each shred arrives. The dashboard shows how many shreds of a block were repaired, but not when any shred came. The timeline has one span, from the first shred to the full block.
- Detail for each transaction in our own blocks. The fee, the compute units and the status come from the transaction status service. That service runs only when RPC history is on. A voting validator has none of this data.
- A delivered packet count for serve repair. Its receiver counts packets and never reports them, so its row on the socket card shows drops with no share. The ancestor hashes and block id repair receivers have the same fault. A fix is in review upstream as anza-xyz/agave#15157.
- QUIC refusals. A failed accept and three refusal paths in the connection table have no counter. The TPU path card shows them as two unaccounted rows, found by subtraction.
- The bundle share of executed transactions. The bundle stage's workers report under a metrics id that BAM's first worker also uses. The card says how many bundles arrived this epoch, not what share of the executed transactions they were.
- Votes under alpenglow. Votes are not transactions and do not use the vote port, so the dashboard hides its vote figures instead of showing zeros. The votor latency point is a summary for the epoch, sent after the epoch is finalized. BLS signature verification reports nothing the dashboard can read.
- Bytes per path on the network card. The host counters give bytes in and out for the whole machine. Of the validator's senders, only gossip and repair report bytes. Turbine goes out over XDP and reports shred counts only. The receivers count packets, not bytes. So the card splits egress into gossip, repair and the rest. It does not split ingress.
- Replay time per program. The point exists but is sent only at trace level.
- Why a slot was skipped. The validator records that a slot has no block, not why.
- Execution time per transaction. Nothing records it. The transaction status service keeps a transaction's fee, compute and status, not how long it took, so a duration histogram or a min, mean and max has no source even on an RPC node.
- Banking stage time by outcome. The workers' timing points sum their stages across every transaction they touched. Nothing splits the time between transactions that landed, failed, or never made the block.
- Fee income by origin address. The address a transaction came from is dropped at signature verification and never reaches the banking stage, the bank or the ledger.
- Compute units by vote, bundle and other. The cost tracker keeps no vote cost on this release, and a bundle's transactions are not marked in the block, so neither share can be cut from the block's compute.
- The busiest accounts of a block. The cost tracker keeps its per-account costs privately and its stats point reports only the costliest, so the block page shows one account where a table was wanted.
- The TPU path per slot. The QUIC streamer, the verifier and the workers report once a second with no slot on the point, so a slot's share of ingress, verification, dedup and execution rejects cannot be cut from them. A slot-exact figure needs the counters read at the instant the slot drains, as Firedancer's GUI does: the streamer's are shareable through a handle, the verifier's and the workers' live on their threads and leave only as the point. The dashboard shows the path per leader turn instead, differenced at the tick after the turn's last slot.
- Non-vote execution time per slot. The consume workers report their time by stage every twenty milliseconds with no slot, and the vote worker once per slot. The block page sums the workers' reports that fell between a block's first shred and its last, so its non-vote figure is out by up to one report at each edge and misses the few milliseconds before the first shred.
- Address lookup failures. The scheduler resolves lookup tables inside its intake and counts a failure under the same counter as a malformed transaction, so the would-not-parse row cannot be split into unresolved, bad table and expired.
- What a thread blocked on. The scheduler statistics give a thread's time on cpu and its time waiting for one, not what it slept on. A PoH thread that reads below full cannot be attributed to a lock or a blockstore read from outside the process; the PoH service's own point carries its lock and record time and would have to be read for that.
- BAM's intake. When BAM builds the block the validator sees its batches arrive at the scheduler and nothing before that. The QUIC and verify counters still count the validator's own TPU, which BAM does not build from, so a turn's path under BAM shows two flows that do not connect.

## What an events system would need to carry

- Everything under metrics datapoints as typed events, with a slot where the point has one. Not datapoints matched by name and gated by the log level.
- A frozen block event with the fields listed under frozen banks, so a consumer never needs to hold a bank.
- The supermajority wait's result for each node, and each reward certificate's membership per slot, from the code that already computes them.
- A way to subscribe from the run command without a change to core. The two config fields the dashboard carries stand in for that today.
