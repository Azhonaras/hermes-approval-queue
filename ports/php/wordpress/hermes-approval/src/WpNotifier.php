<?php
declare(strict_types=1);

namespace Hermes\Approval\Wp;

use Hermes\Approval\Notifier;
use Hermes\Approval\Row;
use Hermes\Approval\Webhook;

/**
 * Decision notifications for WordPress (docs/spec.md, "Decision notifications"): tells the agent's server that a person
 * has decided, so the agent does not have to keep asking.
 *
 * The receiver is set by the site's operator in wp-config.php, never by the agent:
 *   define( 'HERMES_APPROVAL_WEBHOOK_URL',    'https://agent.example/hooks/hermes' );
 *   define( 'HERMES_APPROVAL_WEBHOOK_SECRET', 'a long random string' );   // optional; without it the nudge is unsigned
 *
 * decided() only queues the delivery. It goes out in the `shutdown` action, after the reviewer's answer has been handed
 * to the web server (PHP-FPM and LiteSpeed can finish the request there), so a slow receiver does not hold up the
 * reviewer. On a server that cannot (Apache mod_php, `php -S`) the reviewer waits for the 3 s time-out at most.
 * With WP_HTTP_BLOCK_EXTERNAL, put the receiver's host in WP_ACCESSIBLE_HOSTS.
 */
final class WpNotifier implements Notifier
{
    /** @var list<array{id:int,body:string}> */
    private array $queue = [];
    private bool $hooked = false;

    public function __construct(private readonly string $url, private readonly string $secret = '')
    {
    }

    /** The notifier the constants ask for, or null when none is configured (or the URL is not one we will call). */
    public static function fromConstants(): ?self
    {
        $url = defined('HERMES_APPROVAL_WEBHOOK_URL') ? trim((string) constant('HERMES_APPROVAL_WEBHOOK_URL')) : '';
        if ($url === '') {
            return null;
        }
        if (!Webhook::isValidUrl($url)) {
            error_log('[hermes-approval] HERMES_APPROVAL_WEBHOOK_URL must be a plain http or https URL without a user name; decision notifications are off.');
            return null;
        }
        $secret = defined('HERMES_APPROVAL_WEBHOOK_SECRET') ? (string) constant('HERMES_APPROVAL_WEBHOOK_SECRET') : '';
        return new self($url, $secret);
    }

    public function signed(): bool
    {
        return $this->secret !== '';
    }

    public function decided(Row $row): void
    {
        $this->queue[] = ['id' => $row->approvalId, 'body' => Webhook::body($row)];
        if (!$this->hooked) {
            $this->hooked = true;
            add_action('shutdown', [$this, 'flush'], 100); // after WordPress has flushed its output buffers (priority 1)
        }
    }

    /** Public only because it is a hook callback. Sends what decided() queued. */
    public function flush(): void
    {
        $queue = $this->queue;
        $this->queue = [];
        if ($queue === []) {
            return;
        }
        foreach (['fastcgi_finish_request', 'litespeed_finish_request'] as $finish) {
            if (function_exists($finish)) {
                $finish();
                break;
            }
        }
        foreach ($queue as $item) {
            $this->send($item['id'], $item['body']);
        }
    }

    private function send(int $id, string $body): void
    {
        // wp_remote_post, not wp_safe_remote_post: the operator chose this URL and it may well be on a private network.
        $response = wp_remote_post($this->url, [
            'timeout' => Webhook::TIMEOUT_SECONDS,
            'redirection' => 0,           // the receiver is where the operator said, not where an answer points
            'blocking' => true,           // a non-blocking request still waits for the connect; the time-out above is the cap
            'headers' => Webhook::headers($this->secret, $body),
            'body' => $body,
            'user-agent' => 'Hermes-Approval/0.1',
        ]);
        if (is_wp_error($response)) {
            error_log('[hermes-approval] HRM-' . $id . ': notification not delivered (' . $response->get_error_code() . ')');
        } elseif ((int) wp_remote_retrieve_response_code($response) >= 400) {
            error_log('[hermes-approval] HRM-' . $id . ': the receiver answered ' . (int) wp_remote_retrieve_response_code($response));
        }
    }
}
