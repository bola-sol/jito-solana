# What the dashboard reads

The dashboard runs inside the validator and reads only what the validator already has. This document lists each input: its source, how the dashboard reads it, and what it feeds. It is for anyone who decides what a validator must expose to tools like this one.

There are six kinds of input. The table starts with the most fragile.

| Kind | How the dashboard reads it | Event shaped | What can break it |
| --- | --- | --- | --- |
| Metrics datapoints | An observer sees each datapoint before the validator sends it | Nearly | A renamed point or field; a point that needs a higher log level |
| Frozen banks | A channel that replay writes to, named in the validator config | Yes | A stalled dashboard loses notifications on agave; jito's fan out queues them |
| Gossip and bank forks before the wait | One message on a channel named in the config | Yes | Nothing |
| Bank and bank forks reads | Polled every 200 ms and every second | No | Lock contention; a bank pruned before the read |
| Gossip, blockstore, caches | Direct calls on handles from the run command | No | API changes between releases |
| The host | `/proc`, `/sys` and `statvfs` | Not the validator's to emit | Linux only |

## Metrics datapoints

The validator reports on itself with `solana_metrics` datapoints. The dashboard installs an observer that matches each point by name and field name. It ignores all other fields. If the validator stops sending a point, the figures that use it stop without an error.

### Per slot

Each of these points carries a slot and describes one block.

| Point | Fields read | Feeds |
| --- | --- | --- |
| `replay-slot-stats` | `slot`, `fetch_entries_time`, `confirmation_without_replay_us` or `confirmation_time_us`, `bank_complete_time_us`, `entry_poh_verification_time`, `entry_transaction_verification_time`, `task_submission_us` or `replay_time`, `execute_us`, `execute_details_execute_inner_us`, `execute_details_serialize_us`, `execute_details_deserialize_us`, `execute_details_create_vm_us`, `execute_details_create_executor_load_elf_us`, `execute_details_create_executor_verify_code_us`, `execute_details_create_executor_jit_compile_us`, `load_us`, `store_us`, `program_cache_us`, `validate_transactions_us`, `validate_fees_us`, `filter_executable_us`, `collect_balances_us`, `collect_logs_us`, `update_stakes_cache_us`, `update_transaction_statuses`, `check_block_limits_us`, `total_transactions` | Replay card: time per slot, and its verify and execute breakdowns. The replay step of the schedule page's slot timeline. |
| `shred_insert_is_full` | `slot`, `last_index`, `num_repaired`, `total_time_ms` | Shreds and repaired shreds per slot. The first shred to full block span on the slot timeline. The last shred for the finality figure. |
| `retransmit-stage-slot-stats` | `num_shreds_received_root`, `num_shreds_received_1st_layer`, `num_shreds_received_2nd_layer`, `num_shreds_received_3rd_layer` | Host network card: shreds by turbine layer, over five minutes |
| `cost_tracker_stats` | tag `is_leader`; `bank_slot`, `block_cost`, `costliest_account`, `costliest_account_cost`, `number_of_accounts`, `number_of_contended_accounts`, `allocated_accounts_data_size`, `inflight_transaction_count` | Slot details for our blocks: compute used, and the costliest account. The dashboard drops points without the leader tag. |
| `banking_stage_scheduler_slot_counts` | `slot` and the scheduler counters listed under per second | Slot details: the scheduler waterfall for our leader slots |
| `bundle_stage-stats` (jito only) | `slot`, `num_sanitized_ok`, `execution_results_ok` | Bundles sanitised and landed per produced block |
| `banking_stage_worker_timing` | tag `id`; `cost_model_us`, `load_execute_us`, `load_execute_us_max`, `freeze_lock_us`, `record_us`, `commit_us`, `find_and_send_votes_us` | Slot details: execution time of a produced block, summed over the reports between its first and last shred |
| `banking_stage-leader_slot_vote_execute_and_commit_timings` | `slot`, `load_execute_us`, `freeze_lock_us`, `record_us`, `commit_us`, `find_and_send_votes_us` | The vote worker's part of that execution time |
| `event_handler_slot_tracking` | `slot`, `first_shred`, `parent_ready`, `vote_notarize`, `vote_skip`, `finalized` | Under alpenglow: when our vote for a slot went out, on the list of unrewarded votes. With `shred_insert_is_full`: the slot strip's finality and the Gossip page's time to vote. Votor reports the first shred only for the first slot of a leader window. |

### Per second

These points are running counters. The dashboard subtracts the previous reading each second.

| Point | Fields read | Feeds |
| --- | --- | --- |
| `shred_fetch_receiver`, `shred_fetch_repair_receiver` | `packets_count` | Repaired shreds in the verdict line. The turbine row of the socket ingest card. |
| `retransmit-stage` | tag `is_xdp`; `num_shreds_dropped_xdp_full` | Host network card: shreds dropped because the XDP channel was full |
| `gossip_receiver`, `tpu_vote_receiver` | `packets_count` | Packets delivered on the gossip and vote rows of the socket ingest card |
| `votor_datagram_server` | `datagrams_received` | Under alpenglow: votes delivered on the votor row of the socket ingest card |
| `Gossip`, `Repair` (the streamer senders) | `streamer-send-bytes_total`, `streamer-send-sample_duration_ms` | Host network card: bytes the gossip and repair senders sent |
| `banking_stage_scheduler_counts` | tag `id`; `num_received`, `num_dropped_on_receive`, `num_dropped_on_check_work_queue_full`, `num_dropped_on_parsing_and_sanitization`, `num_dropped_on_validate_locks`, `num_dropped_on_receive_compute_budget`, `num_dropped_on_receive_age`, `num_dropped_on_receive_already_processed`, `num_dropped_on_receive_fee_payer`, `num_dropped_on_filter_key`, `num_dropped_on_nonce_dedup`, `num_buffered`, `num_dropped_on_capacity`, `num_evicted_on_nonce_dedup`, `num_dropped_on_clear`, `num_dropped_on_clean`, `num_scheduled`, `num_unschedulable_conflicts`, `num_unschedulable_threads`, `num_finished`, `num_retryable` | TPU path card: the scheduler section. The `id` tag separates our scheduler from BAM's. The two count `num_received` in different units. |
| `banking_stage_worker_counts`, `banking_stage_worker_error_metrics` | `transactions_attempted_processing_count`, `cost_model_throttled_transactions_count`, `retryable_transaction_count`, `retryable_expired_bank_count`, `processed_transactions_count`, `processed_with_successful_result_count`, `too_many_account_locks`, `account_not_found`, `insufficient_funds`, `invalid_account_for_fee`, `blockhash_not_found`, `blockhash_too_old`, `already_processed`, `invalid_compute_budget`, `max_loaded_accounts_data_size_exceeded`, `invalid_program_for_execution`, `program_execution_temporarily_restricted` | TPU path card: the executed section, summed over the epoch |
| `tpu-verifier` | `total_packets`, `total_dedup`, `total_dropped_below_priority_floor`, `total_valid_packets`, `eviction_drops` | TPU path card: the verify section, summed over the epoch |
| `quic_streamer_tpu`, `quic_streamer_tpu_forwards`, `quic_streamer_tpu_vote` | `total_incoming_connection_attempts`, `connection_rate_limited_across_all`, `connection_rate_limited_per_ipaddr`, `refused_connections_too_many_open_connections`, `connection_setup_timeout`, `connection_setup_error`, `new_connections`, `connection_add_failed`, `connection_add_failed_staked_node`, `connection_add_failed_unstaked_node`, `connection_add_failed_banned`, `connection_added_from_staked_peer`, `connection_added_from_unstaked_peer`, `new_streams`, `throttled_staked_streams`, `throttled_unstaked_streams`, `stream_read_timeouts`, `stream_read_errors`, `invalid_stream_size`, `packets_sent_to_consumer`, `bytes_sent_to_consumer`, `total_handle_chunk_to_packet_send_full_err`, `total_handle_chunk_to_packet_send_disconnected_err`, `open_connections`, `active_streams` | TPU path card: one section per QUIC port. Connection attempts are a running total. Open connections and active streams are levels. |
| `bundle_stage-loop_stats` (jito only) | `num_bundles_received`, `num_packets_received` | TPU path card: the bundles line |
| `accounts_db_store_timings` | `total_bytes`, `total_alive_bytes`, `total_count`, `read_only_accounts_cache_data_size`, `read_only_accounts_cache_entries`, `read_only_accounts_cache_hits`, `read_only_accounts_cache_misses`, `read_only_accounts_cache_evicts` | Caches and storage card: storage size, live share, file count, and the read cache's size and hit rate |
| `accounts_db_load_accounts`, `accounts_db-stores`, `accounts_db-flush_accounts_cache` | `num_loaded_from_write_cache`, `num_loaded_from_read_cache`, `num_loaded_from_index_storage`, `num_accounts_stored`, `account_bytes_stored` (spelled `num_accounts_flushed`, `account_bytes_flushed` on 4.2) | Caches and storage card: where reads were answered from, and what was flushed |
| `loaded-programs-cache-stats` | `hits`, `misses`, `evictions`, `reloads`, `insertions`, `lost_insertions`, `replace_entry`, `one_hit_wonders`, `prunes_orphan`, `prunes_environment`, `empty_entries`, `water_level` | Caches and storage card: the program cache. The water level resets with each bank, so the card shows its peak. |

### Gossip, every two seconds

Gossip sends these points itself and clears each counter when it sends it. The dashboard adds them up. The Gossip page shows rates over ten seconds, and shows when the points stop.

| Point | Fields read | Feeds |
| --- | --- | --- |
| `cluster_info_stats` | `table_size`, `num_pubkeys`, `num_nodes`, `num_nodes_staked` | Gossip table card. These four are levels. The dashboard also counts the points, to see if gossip still reports. |
| `cluster_info_stats2` | `purge_count`, `handle_batch_push_messages_time`, `handle_batch_pull_requests_time`, `handle_batch_pull_responses_time`, `handle_batch_ping_messages_time`, `handle_batch_pong_messages_time`, `handle_batch_prune_messages_time`, `process_gossip_packets_time`, `verify_gossip_packets_time`, `gossip_packets_dropped_count`, `num_redundant_pull_responses` | Entries expired, where gossip spends its time, packets dropped on receive, and redundant pull responses |
| `cluster_info_stats3` | `gossip_transmit_packets_dropped_count`, `gossip_pull_request_no_budget`, `pull_request_scan_budget_exhausted`, `pull_request_ping_pong_check_failed_count`, `bad_prune_destination` | Pressure and rejects card |
| `cluster_info_stats4` | `num_duplicate_push_messages`, `skip_pull_response_shred_version`, `skip_pull_shred_version`, `skip_push_message_shred_version` | Duplicate pushes on the Entries card. The three shred version counts as one figure on the Pressure and rejects card. |
| `cluster_info_stats5` | `packets_received_push_messages_count`, `packets_received_pull_requests_count`, `packets_received_pull_responses_count`, `packets_received_ping_messages_count`, `packets_received_pong_messages_count`, `packets_received_prune_messages_count`, `packets_sent_push_messages_count`, `packets_sent_pull_requests_count`, `packets_sent_pull_responses_count`, `packets_sent_ping_messages_count`, `packets_sent_pong_messages_count`, `packets_sent_prune_messages_count`, `trim_crds_table_purged_values_count`, `num_unverifed_gossip_addrs` | Messages card, in packets. Entries trimmed. Contact records dropped because their address is not verified. |
| `cluster_info_crds_stats` | `all-push`, `all-pull`, and `<type>-push`, `<type>-pull` for each of the fourteen entry types | Entries accepted, by push, pull and type |
| `cluster_info_crds_stats_fails` | `all-push`, `all-pull`, and `<type>-push`, `<type>-pull` | Entries rejected, by push, pull and type |

### Read once, or on change

| Point | Fields read | Feeds |
| --- | --- | --- |
| `xdp-network-config` | tags `driver`, `zero_copy`; `vendor`, `model`, `kernel_version` | Host network card: the XDP transmit setup |
| `wfsm_gossip` | `online_stake`, `offline_stake`, `total_activated_stake` | The exact stake during the supermajority wait. The validator's own progress value is a whole percent. |

## Frozen banks

Replay sends a notification for each bank it freezes. The dashboard adds a sender to `ValidatorConfig::extra_bank_notification_senders`. A relay in the validator copies each notification to that sender and to RPC. The relay uses `try_send` on a channel of 512, so a stalled dashboard loses notifications and does not slow replay. Jito has its own fan out for this. The collector reads each bank once, at freeze, before the validator prunes it.

| Read off the bank | Feeds |
| --- | --- |
| `slot`, `parent_slot` | The key for each slot. Counts are the difference from the parent's totals. |
| `transaction_count`, `non_vote_transaction_count_since_restart` | Transactions and votes per block |
| `transaction_error_count`, `transaction_entries_count` | Failed transactions and entries per block. Failed transactions for TPS, summed along the working fork. |
| `read_cost_tracker`: block cost, block limit, account limit | Compute per block, against its limits |
| `get_collector_fee_details`: total and priority fees | Base and priority fees per block. With the tips, what the block earned us. |
| `get_balance` of the eight tip accounts | Tips per block, as the difference from the parent (jito only) |
| `last_blockhash` | The blockhash of our blocks on Slot details |
| `get_program_accounts_modified_since_parent` for the config program | Validator names and icons that the block changed |
| `vote_accounts`, each staked account's `last_voted_slot` (alpenglow only) | If the block's finalization certificate carried each validator's vote: a last vote within three slots of the newest. The Gossip page's finalization share and the peers table's Finalization column. |

The dashboard keeps our blocks for the current epoch. It keeps the previous epoch until a fifth of the new one has passed. An event with these fields, sent when a block completes, removes the need to hold a bank.

## Gossip and bank forks before the wait

The supermajority wait runs inside the validator constructor, before the run command has handles. So the constructor sends gossip and bank forks on `ValidatorConfig::gossip_ready_sender` just before the wait. Every 250 ms, the dashboard compares the snapshot bank's staked validators with gossip, with the validator's own rule. It shows each validator's stake, version and gossip contact, and this validator's name.

The validator's own walk logs each node but emits only totals. An event for each node removes the dashboard's walk.

## Bank and bank forks reads

The collector polls every 200 ms and holds the bank forks read lock only to clone handles. The meters read the working bank once a second without the lock.

| Call | Feeds |
| --- | --- |
| `BankForks::root_bank`, `working_bank`, `highest_slot`, `frozen_banks` | The slot readouts. Per slot detail where no notification channel is wired. Once, at attach, validator names from the banks frozen while the ledger loaded, which replay does not notify. |
| `BankForks::migration_status`, `Bank::is_alpenglow` | The consensus in use, and which cluster tip to read |
| `Bank::vote_accounts`, with each account's `vote_state_view` | Our stake, commission, BLS key and vote credits this epoch (reward lamports under alpenglow), against the best and the median. The Cluster card's counts and delinquency. Each validator's delinquency and last vote in the certificate lists. Stake in the peer table and in the wait's list. |
| `Bank::get_rank_map` for this epoch and the next, `get_vat_health_for_next_epoch` | Under alpenglow: if our vote account has a seat this epoch and next, and how far it is short of the ticket. The header's "no seat" figure. |
| `Bank::get_lamports_per_signature`, `minimum_vote_account_balance_for_vat`, `get_minimum_balance_for_rent_exemption` | What voting costs: a day of fees under TowerBFT, the admission ticket under alpenglow. The header's balance warnings. |
| `Bank::epoch_schedule`, `epoch`, `slot`, `block_height`, `ns_per_slot_at_slot` | This epoch card, block height and the configured slot time. The root bank's epoch also sets how far back our blocks are kept. |
| `Bank::get_slot_history` on the root bank | The epoch's skip rate, and the produced and skipped counts on Slot details for this epoch and the last. Unlike the ledger, it survives a restart. |
| `Bank::cluster_type` on the root bank | The cluster name in the header |
| `Bank::clock` | The measured slot rate, for the epoch countdown |
| `Bank::get_rank_map` | Our rank in the BLS rank map, to find our bit in a certificate |
| `Bank::get_filtered_indexed_accounts`, `account_indexes_include_key` | Validator names and icons from the config program: before the wait and at attach |
| `BankForks::sharable_banks`, then `Bank::transaction_count`, `non_vote_transaction_count_since_restart` on its working bank | TPS, as the difference each second |
| `Bank::is_frozen`, `parent_slot` on the working bank | The working fork's newest frozen bank, whose failed count TPS reads |

## Gossip, blockstore, caches

| Call | Feeds |
| --- | --- |
| `ClusterInfo::all_peers`, `my_shred_version`, `my_contact_info`, `id` | Cluster versions. Each peer's client, version and address. Our identity, shred version and ports, which match the socket ingest rows to `/proc/net/udp`. When we last heard each validator: "no gossip" after five minutes. |
| `ClusterInfo::all_peers`, with each contact's `rpc`, `outset` and local timestamp, and `gossip.crds` read with `get` for each peer's `SnapshotHashes` and `LowestSlot` | The Gossip page's peers table: RPC port, last heard, start time, snapshot lag behind our root, and ledger depth. Read every five seconds, only while a page asks. |
| `ClusterInfo::rpc_peers` | The RPC node count |
| `ClusterInfo::tvu_peers`, with each contact's wallclock | Who counts as seen during the supermajority wait |
| `Blockstore::meta`, `is_full`, `lowest_slot`, `ledger_path` | First shred times, skipped slots, how far back our blocks can be read, and the ledger's filesystem |
| `Blockstore::is_root`, and `get_slot_components_with_shred_info` on a rooted block's last two FEC sets | Under alpenglow, the reward certificates in each rooted block's footer, read with the rank map. A skipped block paid nobody. If our vote was paid for each slot, and how many slots each rank was paid this epoch. The cause of each unpaid slot, and the writer of each certificate. The count starts when the dashboard starts. |
| `Blockstore::get_slot_entries` on our slots, once full | Our blocks' non-vote transactions by message version: legacy, v0, v1 |
| `Blockstore::get_latest_optimistic_slots`, `highest_slot` | The cluster tip under TowerBFT: the last confirmed slot, but not below the highest slot with shreds. After a restart, the confirmed slot is older than the snapshot. |
| `BlockCommitmentCache::highest_confirmed_slot`, `highest_super_majority_root`, `root` | The confirmed, rooted and finalized levels on the slot strip |
| `Validator::highest_finalized` | The cluster tip under alpenglow, from votor's last certificate |
| `LeaderScheduleCache::slot_leader_at`, `get_epoch_leader_schedule` with `get_leader_upcoming_slots`, `next_leader_slot` | The epoch's leader turns, our leader slots, the validators the peer table lists, and the countdown to our next slot |
| `ValidatorStartProgress` | The boot phases and their times |
| The snapshot archive directories, through `agave_snapshots::paths`, and the intervals in `SnapshotConfig` | The newest full and incremental snapshots, their age, and when the next are due. A snapshot being written, and how long the last took. Under alpenglow, the slots each write spanned, which the miss list gives as a cause. Read every second, watched or not. |
| `solana_version::Version::this_build` | The client, version and commit in the header |

The certificate walk is the only place where the dashboard parses ledger bytes. A per slot event that names the validators each reward certificate paid would replace it. The leader knows this when it writes the footer.

## What the pages ask for

A page can ask for data that is too large or too rare to push. Each answer comes from what the dashboard keeps. No request reads a new input.

| Request | Answers with |
| --- | --- |
| `slot.range` | Up to 4,096 rows of the slot history, which holds 432,000 slots |
| `slot.search` | Up to 128 leader turns that match a name, key or slot number, or our own turns. One search at a time, on a blocking thread. |
| `epoch.query` | An epoch's slots, leader turns, our leader slots and cost limits |
| `summary.displays` | Validator names and icons |
| `summary.misses`, `summary.written` | Our unrewarded votes, and how often our certificates left out each validator |
| `peers.gossip` | The Gossip page's peers table |
| `produced.figures` | This epoch's blocks, and the previous epoch's until a fifth of this one has passed, newest first, 1,024 to a page: nine numbers per block, with their leader turns |
| `produced.detail` | Our blocks in a range of up to 64 slots, with their turns, waterfalls and costs |

## The host

The validator does not own these inputs. The dashboard reads them directly:

- CPU, load and memory: `/proc/stat`, `/proc/loadavg`, `/proc/meminfo`, and `/proc/self/status` for the validator's resident memory.
- Disks: `/proc/diskstats`, `statvfs` on the ledger, accounts and snapshot paths, and `/sys/dev/block/<major>:<minor>` with its `partition` marker.
- Network: `/proc/net/dev`, `/proc/net/route`, and `/sys/class/net/<interface>` (`type`, `flags`, `operstate`, `mtu`, `uevent`, and the `device`, `bonding`, `bridge` and `tun_flags` entries).
- Sockets: `/proc/net/udp` and `udp6`, for drops and queues.
- Threads: `comm`, `schedstat` and `status` under `/proc/self/task`.
- CPU governor: `/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor`.

The kernel counts socket drops but not deliveries. The delivered counts come from the datapoints above.

## What the dashboard could not read

The validator has no input for these planned panels.

- A shred timeline. The validator does not record when each shred arrives. The slot timeline shows one span, from the first shred to the full block.
- Transaction detail for our blocks. The fee, compute and status come from the transaction status service, which runs only with RPC history.
- Delivered packets for serve repair. Its receiver does not report its count, so its row shows drops with no share. The ancestor hashes and block id repair receivers have the same fault. A fix is in review: anza-xyz/agave#15157.
- QUIC refusals. A failed accept and three refusal paths have no counter. The TPU path card shows them as two rows, found by subtraction.
- The bundle share of executed transactions. The bundle stage's workers use the same metrics id as BAM's first worker.
- Vote figures under alpenglow. Votes are not transactions, so the dashboard hides its vote figures. The socket ingest card counts votes on the votor port. The votor latency point is a summary, sent after the epoch is finalized. BLS verification reports nothing the dashboard can read.
- Bytes per path on the Host network card. Only the gossip and repair senders report bytes. Turbine over XDP reports shred counts, and receivers count packets. So the card splits egress into gossip, repair and the rest, and does not split ingress.
- Replay time per program. The point exists, but only at trace level.
- Why a slot was skipped. The validator records that a slot has no block, not why.
- Execution time per transaction. Nothing records it, not even on an RPC node.
- Banking stage time by outcome. The worker timings sum all transactions, landed or not.
- Fee income by origin address. Signature verification drops the source address.
- Compute by vote, bundle and other. The cost tracker keeps no vote cost on this release, and the block does not mark bundle transactions.
- The busiest accounts of a block. The cost tracker keeps its per-account costs private. Its point reports only the costliest.
- The TPU path per slot. The streamer, verifier and workers report each second, with no slot. The dashboard shows the path per leader turn.
- Non-vote execution time per slot. The workers report every 20 ms, with no slot. The block figure sums the reports between the first and last shred, so each edge can be off by one report.
- Address lookup failures. The scheduler counts them with malformed transactions.
- What a thread blocked on. The scheduler statistics give time on a CPU and time waiting, not the cause.
- BAM's intake. Under BAM, the validator sees batches only at the scheduler. The QUIC and verify counters count its own TPU, which BAM does not use.
- Gossip traffic per peer. Gossip keeps no counts per peer.
- Bytes per gossip message or entry type. Gossip counts messages and entries, not their size.
- Gossip entries per type. The gossip table walk is crate-private, and its point gives only the total.

## Agave's event system

Anza is writing an event system for the validator: the `agave-event-system` crate in [anza-xyz/agave-sdk](https://github.com/anza-xyz/agave-sdk). The validator publishes typed events to named streams in shared memory. Other processes subscribe to these streams. The system operates on Linux only. On other platforms, each operation does nothing.

These properties change how the dashboard can use it:

- All streams are off by default. A policy enables streams by the start of their name, for example `off,slot.=on`.
- A slow subscriber does not slow the validator. When a subscriber does not read fast enough, the publisher drops new events and counts them.
- A subscriber can decode events without the validator's types, because each stream keeps the schema of its events.

On 2026-10-08, agave does not publish events, and the crate defines no validator events. The dashboard reads none of its inputs from this system.

### What the dashboard needs from it

| Kind | Stream needed | Notes |
| --- | --- | --- |
| Metrics datapoints | One typed stream for each point, with the slot where the point has one | Counters must be running totals, not counts since the last event. Then a dropped event loses resolution, not counts. |
| Frozen banks | One event for each frozen block, with the fields listed under frozen banks | Then no subscriber holds a bank. |
| Gossip and bank forks before the wait | One event for each node during the supermajority wait: its stake, its version, and if gossip has a fresh contact | The validator's own walk already calculates this. |
| Bank and bank forks reads | State streams: the leader schedule, stakes and rank map at the start of each epoch, and each vote account when it changes | A subscriber that starts late needs the full value. A state stream must send the full value at an interval, not only when it changes. |
| Gossip, blockstore, caches | For each slot, the validators that its reward certificate paid. For each peer, its contact information when it changes | The leader knows the certificate's members when it writes the footer. With this stream, the dashboard does not parse ledger bytes. |
| The host | None | A separate process can read these inputs itself. |

### What changes for the dashboard

- The dashboard can operate as a separate process. The validator only publishes events, and the dashboard needs no change to core.
- The validator needs two settings: the event system's directory and the stream policy. The dashboard must document the stream names it needs.
- A dropped event is a gap in the data. The dashboard must show the gap, not a zero. The publisher's count of dropped events tells it when a gap occurs.
- Until state streams exist, the bank, gossip and blockstore reads stay inside the validator. The metrics and frozen block streams can replace the metrics observer and the bank notification channel first.
