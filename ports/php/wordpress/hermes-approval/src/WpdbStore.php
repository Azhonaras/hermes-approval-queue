<?php
declare(strict_types=1);

namespace Hermes\Approval\Wp;

use Hermes\Approval\JObject;
use Hermes\Approval\Json;
use Hermes\Approval\Row;
use Hermes\Approval\Store\ApprovalStore;

/**
 * Approval rows in MySQL/MariaDB through $wpdb, so a write and its claim share WordPress's own connection
 * and therefore one transaction. Tables are InnoDB; times are UTC DATETIME(3).
 */
final class WpdbStore implements ApprovalStore
{
    private const COLUMNS = 'approval_id, site_id, resource_type, resource_id_json, action, scope, status, reason, proposal_json,
        original_proposal_json, edited_proposal, decision_reason, revision_of, created_utc, decided_utc, decided_by, expires_utc';

    /** Deadlocks and lock-wait timeouts are retried: the losing transaction was rolled back by the server and is safe to run again. */
    private const RETRYABLE = [1205, 1213];
    private const ATTEMPTS = 4;

    public static function table(string $name = 'approvals'): string
    {
        global $wpdb;
        return $wpdb->prefix . 'hermes_' . $name;
    }

    public static function install(): void
    {
        global $wpdb;
        $charset = $wpdb->get_charset_collate();
        $approvals = self::table();
        $audit = self::table('audit');
        // resource_id_json holds the JSON value, so 42 and "42" stay different resources.
        $wpdb->query("CREATE TABLE IF NOT EXISTS $approvals (
            approval_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            site_id INT NOT NULL,
            resource_type VARCHAR(100) NOT NULL,
            resource_id_json VARCHAR(200) NOT NULL,
            action VARCHAR(100) NOT NULL,
            scope VARCHAR(100) NOT NULL,
            status VARCHAR(20) NOT NULL,
            reason TEXT NOT NULL,
            proposal_json MEDIUMTEXT NOT NULL,
            original_proposal_json MEDIUMTEXT NULL,
            edited_proposal TINYINT(1) NOT NULL DEFAULT 0,
            decision_reason TEXT NULL,
            revision_of BIGINT UNSIGNED NULL,
            created_utc DATETIME(3) NOT NULL,
            decided_utc DATETIME(3) NULL,
            decided_by VARCHAR(255) NULL,
            expires_utc DATETIME(3) NOT NULL,
            consumed_utc DATETIME(3) NULL,
            PRIMARY KEY (approval_id),
            KEY status_created (status, created_utc)
        ) ENGINE=InnoDB $charset");
        $wpdb->query("CREATE TABLE IF NOT EXISTS $audit (
            audit_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            approval_id BIGINT UNSIGNED NOT NULL,
            action VARCHAR(100) NOT NULL,
            resource_type VARCHAR(100) NOT NULL,
            resource_id_json VARCHAR(200) NOT NULL,
            proposal_json MEDIUMTEXT NOT NULL,
            at_utc DATETIME(3) NOT NULL,
            PRIMARY KEY (audit_id),
            KEY approval (approval_id)
        ) ENGINE=InnoDB $charset");
    }

    public function insert(array $v): Row
    {
        $this->run($this->sql('INSERT INTO ' . self::table() . ' (site_id, resource_type, resource_id_json, action, scope, status, reason,
            proposal_json, edited_proposal, revision_of, created_utc, expires_utc) VALUES (%d, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s, %s)',
            $v['siteId'], $v['resourceType'], Json::encode($v['resourceId']), $v['action'], $v['scope'], $v['status'], $v['reason'],
            Json::encode($v['proposal']), $v['revisionOfApprovalId'], self::toDb($v['createdUtc']), self::toDb($v['expiresUtc'])));
        global $wpdb;
        return $this->get((int) $wpdb->insert_id) ?? throw new \RuntimeException('Inserted row not found.');
    }

    public function get(int $id): ?Row
    {
        global $wpdb;
        $this->run($this->sql('SELECT ' . self::COLUMNS . ' FROM ' . self::table() . ' WHERE approval_id = %d', $id));
        $r = $wpdb->last_result[0] ?? null;
        return $r ? self::map($r) : null;
    }

    public function list(?array $statuses = null): array
    {
        global $wpdb;
        $where = $statuses ? ' WHERE status IN (' . implode(',', array_map(fn ($s) => $this->sql('%s', $s), $statuses)) . ')' : '';
        $this->run('SELECT ' . self::COLUMNS . ' FROM ' . self::table() . $where . ' ORDER BY created_utc DESC, approval_id DESC');
        return array_map([self::class, 'map'], $wpdb->last_result ?: []);
    }

    public function transition(int $id, string $from, array $patch): ?Row
    {
        global $wpdb;
        $this->run($this->sql('UPDATE ' . self::table() . ' SET ' . $this->setClause($patch) . ' WHERE approval_id = %d AND status = %s', $id, $from));
        return $wpdb->rows_affected === 1 ? $this->get($id) : null;
    }

    public function consume(int $id, string $nowUtc, callable $apply): array
    {
        for ($attempt = 1; ; $attempt++) {
            try {
                return $this->consumeOnce($id, $nowUtc, $apply);
            } catch (RetryableDbError $e) {
                if ($attempt >= self::ATTEMPTS) {
                    throw new \RuntimeException('The database stayed busy; try again.', 0, $e);
                }
                usleep(random_int(5, 40) * 1000);
            }
        }
    }

    private function consumeOnce(int $id, string $nowUtc, callable $apply): array
    {
        global $wpdb;
        $claimed = null;
        $this->run('START TRANSACTION');
        try {
            // The claim: only one transaction can move Approved -> Consumed; the others wait on the row lock,
            // then find the status changed and update nothing.
            $this->run($this->sql('UPDATE ' . self::table() . ' SET status = %s, consumed_utc = %s WHERE approval_id = %d AND status = %s',
                'Consumed', self::toDb($nowUtc), $id, 'Approved'));
            if ($wpdb->rows_affected !== 1) {
                $this->run('ROLLBACK');
                return [null, null];
            }
            $claimed = $this->get($id);
            $result = $apply($claimed);
            $this->run($this->sql('INSERT INTO ' . self::table('audit') . ' (approval_id, action, resource_type, resource_id_json, proposal_json, at_utc)
                VALUES (%d, %s, %s, %s, %s, %s)', $id, $claimed->action, $claimed->resourceType, Json::encode($claimed->resourceId),
                Json::encode($claimed->proposal), self::toDb($nowUtc)));
            $this->run('COMMIT');
            return [$claimed, $result];
        } catch (\Throwable $e) {
            $wpdb->query('ROLLBACK'); // the claim is undone too: the row is Approved again and can be retried
            if ($claimed !== null) {
                do_action('hermes_approval_rolled_back', $claimed);
            }
            throw $e;
        }
    }

    // ------------------------------------------------------------------ helpers

    /** $wpdb->prepare without its NULL problem: null becomes SQL NULL instead of ''. */
    private function sql(string $template, mixed ...$args): string
    {
        global $wpdb;
        $parts = preg_split('/(%[ds])/', $template, -1, PREG_SPLIT_DELIM_CAPTURE);
        $out = '';
        $n = 0;
        foreach ($parts as $part) {
            if ($part !== '%d' && $part !== '%s') {
                $out .= $part;
                continue;
            }
            $value = $args[$n++];
            $out .= $value === null ? 'NULL' : ($part === '%d' ? (string) (int) $value : "'" . $wpdb->_real_escape((string) $value) . "'");
        }
        return $out;
    }

    private function setClause(array $patch): string
    {
        $map = ['status' => 'status', 'decisionReason' => 'decision_reason', 'decidedUtc' => 'decided_utc', 'decidedBy' => 'decided_by',
            'proposal' => 'proposal_json', 'originalProposal' => 'original_proposal_json', 'editedProposal' => 'edited_proposal'];
        $sets = [];
        foreach ($patch as $key => $value) {
            $column = $map[$key] ?? throw new \InvalidArgumentException("Unknown patch field $key");
            $value = match ($key) {
                'decidedUtc' => $value === null ? null : self::toDb($value),
                'proposal', 'originalProposal' => $value === null ? null : Json::encode($value),
                'editedProposal' => $value ? 1 : 0,
                default => $value,
            };
            $sets[] = $column . ' = ' . $this->sql(is_int($value) ? '%d' : '%s', $value);
        }
        return implode(', ', $sets);
    }

    /** Runs one statement with errors hidden from the page (they would corrupt the JSON) and raised as exceptions instead. */
    private function run(string $sql): void
    {
        global $wpdb;
        $shown = $wpdb->hide_errors();
        $ok = $wpdb->query($sql);
        $wpdb->show_errors($shown);
        if ($ok === false) {
            $errno = $wpdb->dbh instanceof \mysqli ? $wpdb->dbh->errno : 0;
            if (in_array($errno, self::RETRYABLE, true)) {
                throw new RetryableDbError($wpdb->last_error, $errno);
            }
            throw new \RuntimeException('Database error: ' . $wpdb->last_error);
        }
    }

    /** How many rows wait for a decision (the admin menu's count). Rows past their expiry still count until the queue is opened. */
    public static function countPending(): int
    {
        global $wpdb;
        return (int) $wpdb->get_var($wpdb->prepare('SELECT COUNT(*) FROM ' . self::table() . ' WHERE status = %s', 'Pending'));
    }

    private static function toDb(string $iso): string
    {
        return str_replace(['T', 'Z'], [' ', ''], $iso);
    }

    /**
     * DATETIME text back to ISO-8601 with milliseconds. MySQL DATETIME(3) keeps them; SQLite (WordPress Playground) keeps
     * whole seconds only, so the fraction is optional here and always present in what the API returns.
     */
    private static function fromDb(?string $value): ?string
    {
        if ($value === null) {
            return null;
        }
        if (preg_match('/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/D', $value, $m) !== 1) {
            throw new \UnexpectedValueException('Unreadable time in the approvals table: ' . $value);
        }
        return $m[1] . 'T' . $m[2] . '.' . str_pad(substr($m[3] ?? '', 0, 3), 3, '0') . 'Z';
    }

    private static function map(object $r): Row
    {
        return new Row(
            (int) $r->approval_id, (int) $r->site_id, $r->resource_type, Json::parseStored($r->resource_id_json), $r->action, $r->scope,
            $r->status, $r->reason, Json::parseStored($r->proposal_json),
            $r->original_proposal_json === null ? null : Json::parseStored($r->original_proposal_json),
            (bool) (int) $r->edited_proposal, $r->decision_reason, $r->revision_of === null ? null : (int) $r->revision_of,
            self::fromDb($r->created_utc), self::fromDb($r->decided_utc), $r->decided_by, self::fromDb($r->expires_utc),
        );
    }
}

final class RetryableDbError extends \RuntimeException
{
}
