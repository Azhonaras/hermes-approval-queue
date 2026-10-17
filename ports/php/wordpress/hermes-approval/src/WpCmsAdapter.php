<?php
declare(strict_types=1);

namespace Hermes\Approval\Wp;

use Hermes\Approval\CmsAdapter;
use Hermes\Approval\JObject;
use Hermes\Approval\Row;

/**
 * Real WordPress content. Resource types are post types ("post", "page", ...) addressed by post ID, and "term"
 * addressed by term ID. Each action has one write path and a whitelist of fields; anything else is refused.
 * Writes go through WordPress's own functions, on $wpdb's connection, so they join the approval's transaction.
 */
final class WpCmsAdapter implements CmsAdapter
{
    /** Post fields an action may change: proposal key => [kind, target]. */
    private const POST_FIELDS = [
        'update:onpage' => [
            'title' => ['post', 'post_title'], 'excerpt' => ['post', 'post_excerpt'], 'slug' => ['post', 'post_name'],
            'titleSeo' => ['meta', '_hermes_title_seo'], 'descriptionSeo' => ['meta', '_hermes_description_seo'],
        ],
        'update:content' => ['content' => ['post', 'post_content']],
        'update:canonical' => ['canonical' => ['meta', '_hermes_canonical']],
        'update:redirect' => ['redirect' => ['meta', '_hermes_redirect']],
        'update:indexing' => ['noindex' => ['meta', '_hermes_noindex']],
        'update:schema' => ['schema' => ['meta', '_hermes_schema']],
    ];

    /** What a read returns for a post: the fields above, by their proposal names. */
    private const READ_META = [
        'canonical' => '_hermes_canonical', 'titleSeo' => '_hermes_title_seo', 'descriptionSeo' => '_hermes_description_seo',
        'redirect' => '_hermes_redirect', 'noindex' => '_hermes_noindex', 'schema' => '_hermes_schema',
    ];

    /** Post actions without fields: delete moves the post to the trash, where an editor can restore it. */
    private const POST_ACTIONS = ['delete:post'];

    /** Term actions this adapter can write, with the fields each accepts. */
    private const TERM_ACTIONS = ['update:taxonomy' => ['name', 'slug', 'description'], 'delete:taxonomy' => [], 'merge:taxonomy' => ['into']];

    /**
     * Exactly the actions that have a write path here. The profile (and so the manifest and validation) lists these and
     * nothing else: a human must never be asked to approve an action that could not run.
     * @return list<string>
     */
    public static function actions(): array
    {
        return [...array_keys(self::POST_FIELDS), ...self::POST_ACTIONS, ...array_keys(self::TERM_ACTIONS)];
    }

    /**
     * The fields each action can write, for the manifest: the agent learns the names instead of guessing them, and the
     * review page warns about a field that has no write path (the queue itself accepts any JSON object, as on every stack).
     * @return array<string, list<string>>
     */
    public static function fields(): array
    {
        $out = [];
        foreach (self::POST_FIELDS as $action => $map) {
            $out[$action] = array_keys($map);
        }
        foreach (self::POST_ACTIONS as $action) {
            $out[$action] = [];
        }
        return $out + self::TERM_ACTIONS;
    }

    public function read(int $siteId, string $resourceType, int|float|string $resourceId): ?JObject
    {
        if ($siteId !== get_current_blog_id() || !is_int($resourceId) || $resourceId <= 0) {
            return null;
        }
        if ($resourceType === 'term') {
            $term = get_term($resourceId);
            return $term instanceof \WP_Term
                ? JObject::from(['name' => $term->name, 'slug' => $term->slug, 'taxonomy' => $term->taxonomy, 'description' => $term->description])
                : null;
        }
        $post = get_post($resourceId);
        if (!$post instanceof \WP_Post || $post->post_type !== $resourceType || $post->post_status === 'trash') {
            return null;
        }
        $fields = ['title' => $post->post_title, 'excerpt' => $post->post_excerpt, 'slug' => $post->post_name, 'status' => $post->post_status,
            'content' => $post->post_content];
        foreach (self::READ_META as $name => $key) {
            $fields[$name] = (string) get_post_meta($post->ID, $key, true);
        }
        return JObject::from($fields);
    }

    public function apply(Row $row): mixed
    {
        if ($row->siteId !== get_current_blog_id() || !is_int($row->resourceId)) {
            throw new \RuntimeException('No such resource on this site.');
        }
        // The change is made as the reviewer who approved it: WordPress checks their rights, attributes the
        // revision to them, and filters HTML by their role. An approval never grants more than the approver has.
        $reviewer = $row->decidedBy === null ? false : get_user_by('login', $row->decidedBy);
        if (!$reviewer instanceof \WP_User) {
            throw new \RuntimeException('The approving reviewer no longer exists.');
        }
        $previous = get_current_user_id();
        wp_set_current_user($reviewer->ID);
        try {
            $this->assertAllowed($row);
            return $row->resourceType === 'term' ? $this->applyTerm($row) : $this->applyPost($row);
        } finally {
            wp_set_current_user($previous);
        }
    }

    /** Called by the store after a rollback: the object cache may still hold values the database no longer has. */
    public static function forget(Row $row): void
    {
        if (!is_int($row->resourceId)) {
            return;
        }
        if ($row->resourceType === 'term') {
            clean_term_cache($row->resourceId);
        } else {
            clean_post_cache($row->resourceId);
            wp_cache_delete($row->resourceId, 'post_meta');
        }
    }

    private function assertAllowed(Row $row): void
    {
        $allowed = match (true) {
            $row->resourceType !== 'term' && in_array($row->action, self::POST_ACTIONS, true) => current_user_can('delete_post', $row->resourceId),
            $row->resourceType !== 'term' => current_user_can('edit_post', $row->resourceId),
            str_starts_with($row->action, 'delete:'), str_starts_with($row->action, 'merge:') => current_user_can('delete_term', $row->resourceId),
            default => current_user_can('edit_term', $row->resourceId),
        };
        if (!$allowed) {
            throw new \RuntimeException('The approving reviewer may not change this ' . $row->resourceType . '.');
        }
    }

    private function applyPost(Row $row): JObject
    {
        $post = get_post($row->resourceId);
        if (!$post instanceof \WP_Post || $post->post_type !== $row->resourceType || $post->post_status === 'trash') {
            throw new \RuntimeException('No such ' . $row->resourceType . '.');
        }
        if ($row->action === 'delete:post') {
            // The trash, not a permanent delete: a wrong approval can be undone from Posts -> Trash.
            if (!wp_trash_post($post->ID) instanceof \WP_Post) {
                throw new \RuntimeException('WordPress refused to move the post to the trash.');
            }
            return JObject::from(['status' => 'trash']);
        }
        $fields = self::POST_FIELDS[$row->action] ?? throw new \RuntimeException('No write path for ' . $row->action . ' on posts.');
        $postChanges = [];
        foreach ($row->proposal->pairs() as $name => $value) {
            [$kind, $target] = $fields[$name] ?? throw new \RuntimeException("Field \"$name\" is not part of {$row->action}.");
            if ($kind === 'post') {
                $postChanges[$target] = self::text($name, $value);
            }
        }
        // Post fields first, then meta, in proposal order: if a later field is refused, the earlier writes are
        // already in the database and only the transaction rollback removes them (the conformance suite checks this).
        if ($postChanges) {
            // wp_update_post() and wp_update_term() unslash what they are given: slash it, or every backslash the
            // reviewer approved (a Windows path, code, LaTeX) is silently removed from the saved text.
            $result = wp_update_post(wp_slash(['ID' => $post->ID] + $postChanges), true);
            if (is_wp_error($result)) {
                throw new \RuntimeException($result->get_error_message());
            }
        }
        foreach ($row->proposal->pairs() as $name => $value) {
            [$kind, $target] = $fields[$name];
            if ($kind === 'meta') {
                update_post_meta($post->ID, $target, wp_slash(self::validateMeta($name, $value)));
            }
        }
        clean_post_cache($post->ID);
        return $this->read($row->siteId, $row->resourceType, $row->resourceId) ?? new JObject();
    }

    private function applyTerm(Row $row): mixed
    {
        $p = $row->proposal;
        switch ($row->action) {
            case 'update:taxonomy':
                $term = get_term($row->resourceId);
                if (!$term instanceof \WP_Term) {
                    throw new \RuntimeException('No such term.');
                }
                $args = [];
                foreach (['name', 'slug', 'description'] as $k) {
                    if ($p->has($k)) {
                        $args[$k] = self::text($k, $p->get($k));
                    }
                }
                foreach ($p->keys() as $k) {
                    if (!in_array($k, ['name', 'slug', 'description'], true)) {
                        throw new \RuntimeException("Field \"$k\" is not part of update:taxonomy.");
                    }
                }
                $r = wp_update_term($term->term_id, $term->taxonomy, wp_slash($args));
                break;
            case 'delete:taxonomy':
                $term = get_term($row->resourceId);
                if (!$term instanceof \WP_Term) {
                    throw new \RuntimeException('No such term.');
                }
                $r = wp_delete_term($term->term_id, $term->taxonomy);
                break;
            case 'merge:taxonomy':
                $term = get_term($row->resourceId);
                $into = $p->get('into');
                if (!$term instanceof \WP_Term || !is_int($into) || !(get_term($into) instanceof \WP_Term)) {
                    throw new \RuntimeException('merge:taxonomy needs an existing term and an existing "into" term id.');
                }
                $r = wp_delete_term($term->term_id, $term->taxonomy, ['default' => $into, 'force_default' => true]);
                break;
            default:
                throw new \RuntimeException('No write path for ' . $row->action . ' on terms.');
        }
        if (is_wp_error($r)) {
            throw new \RuntimeException($r->get_error_message());
        }
        if ($r === false || $r === 0) {
            throw new \RuntimeException('WordPress refused the change.');
        }
        return $this->read($row->siteId, 'term', $row->resourceId);
    }

    private static function text(string $name, mixed $value): string
    {
        if (!is_string($value)) {
            throw new \RuntimeException("\"$name\" must be text.");
        }
        return $value;
    }

    /** A real CMS validates what it saves. These rules are what an SEO editor would enforce. */
    private static function validateMeta(string $name, mixed $value): string
    {
        switch ($name) {
            case 'canonical':
            case 'redirect':
                $url = self::text($name, $value);
                if ($url !== '' && (!preg_match('~^https?://\S+$~D', $url) || filter_var($url, FILTER_VALIDATE_URL) === false)) {
                    throw new \RuntimeException("$name must be an absolute http(s) URL");
                }
                return $url;
            case 'titleSeo':
                $t = self::text($name, $value);
                if (mb_strlen($t) > 200) {
                    throw new \RuntimeException('titleSeo is longer than 200 characters');
                }
                return $t;
            case 'noindex':
                if (!is_bool($value)) {
                    throw new \RuntimeException('noindex must be true or false');
                }
                return $value ? '1' : '';
            case 'schema':
                if (!$value instanceof JObject) {
                    throw new \RuntimeException('schema must be a JSON object');
                }
                return \Hermes\Approval\Json::encode($value);
            default:
                return self::text($name, $value);
        }
    }
}
