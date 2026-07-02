<?php
declare(strict_types=1);

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

const MAX_ATTACHMENTS = 12;
const MAX_ATTACHMENT_BYTES = 31457280;
const MEMBER_TTL_SECONDS = 70;
const ROOM_NAME_MAX_LENGTH = 60;

$storageDir = __DIR__ . DIRECTORY_SEPARATOR . 'storage';
$stateFile = $storageDir . DIRECTORY_SEPARATOR . 'rooms.json';

ensureStorage($storageDir, $stateFile);

$action = isset($_GET['action']) ? (string) $_GET['action'] : '';
$rawInput = file_get_contents('php://input');
$input = json_decode($rawInput ?: '{}', true);
if (!is_array($input)) {
    $input = [];
}

try {
    $response = withState($stateFile, function (array &$state) use ($action, $input): array {
        cleanupExpiredMembers($state);

        switch ($action) {
            case 'ping':
                return ['ok' => true, 'message' => 'pong'];

            case 'generate_match':
                $roomId = generateUniqueRoomCode($state['rooms']);
                ensureRoomExists($state, $roomId);
                return [
                    'ok' => true,
                    'room' => $roomId,
                    'roomName' => $state['rooms'][$roomId]['roomName'],
                ];

            case 'join':
            case 'poll':
                $roomId = normalizeRoom($input['room'] ?? '');
                $clientId = sanitizeClientId($input['clientId'] ?? '');
                if ($roomId === '' || $clientId === '') {
                    return failPayload('Room and clientId required');
                }

                ensureRoomExists($state, $roomId);
                touchMember($state['rooms'][$roomId], $clientId);
                return buildRoomPayload($roomId, $state['rooms'][$roomId]);

            case 'update':
                $roomId = normalizeRoom($input['room'] ?? '');
                $clientId = sanitizeClientId($input['clientId'] ?? '');
                $shared = isset($input['shared']) && is_array($input['shared']) ? $input['shared'] : null;
                if ($roomId === '' || $clientId === '' || $shared === null) {
                    return failPayload('Invalid update payload');
                }

                ensureRoomExists($state, $roomId);
                touchMember($state['rooms'][$roomId], $clientId);
                $state['rooms'][$roomId]['shared'] = sanitizeShared($state['rooms'][$roomId]['shared'], $shared);
                $state['rooms'][$roomId]['lastUpdatedAt'] = timeMs();
                $state['rooms'][$roomId]['lastUpdatedBy'] = 'Participant';
                return buildRoomPayload($roomId, $state['rooms'][$roomId]);

            case 'attachment_add':
                $roomId = normalizeRoom($input['room'] ?? '');
                $clientId = sanitizeClientId($input['clientId'] ?? '');
                $attachment = isset($input['attachment']) && is_array($input['attachment']) ? $input['attachment'] : null;
                if ($roomId === '' || $clientId === '' || $attachment === null) {
                    return failPayload('Invalid attachment payload');
                }

                ensureRoomExists($state, $roomId);
                touchMember($state['rooms'][$roomId], $clientId);
                if (count($state['rooms'][$roomId]['shared']['attachments']) >= MAX_ATTACHMENTS) {
                    return failPayload('Max attachments reached');
                }

                $safeAttachment = sanitizeAttachment($attachment);
                if ($safeAttachment === null) {
                    return failPayload('Invalid attachment');
                }

                $safeAttachment['ownerId'] = $clientId;
                $state['rooms'][$roomId]['shared']['attachments'][] = $safeAttachment;
                $state['rooms'][$roomId]['lastUpdatedAt'] = timeMs();
                $state['rooms'][$roomId]['lastUpdatedBy'] = 'Participant';
                return buildRoomPayload($roomId, $state['rooms'][$roomId]);

            case 'attachment_remove':
                $roomId = normalizeRoom($input['room'] ?? '');
                $clientId = sanitizeClientId($input['clientId'] ?? '');
                $attachmentId = isset($input['attachmentId']) ? (string) $input['attachmentId'] : '';
                if ($roomId === '' || $clientId === '' || $attachmentId === '') {
                    return failPayload('Invalid attachment remove payload');
                }

                ensureRoomExists($state, $roomId);
                touchMember($state['rooms'][$roomId], $clientId);
                $attachments = &$state['rooms'][$roomId]['shared']['attachments'];
                $index = findAttachmentIndex($attachments, $attachmentId);
                if ($index < 0) {
                    return failPayload('Attachment not found');
                }
                if (($attachments[$index]['ownerId'] ?? '') !== $clientId) {
                    return failPayload('Only uploader can delete');
                }

                array_splice($attachments, $index, 1);
                $state['rooms'][$roomId]['lastUpdatedAt'] = timeMs();
                $state['rooms'][$roomId]['lastUpdatedBy'] = 'Participant';
                return buildRoomPayload($roomId, $state['rooms'][$roomId]);

            case 'room_name_update':
                $roomId = normalizeRoom($input['room'] ?? '');
                $clientId = sanitizeClientId($input['clientId'] ?? '');
                if ($roomId === '' || $clientId === '') {
                    return failPayload('Invalid room name payload');
                }

                ensureRoomExists($state, $roomId);
                touchMember($state['rooms'][$roomId], $clientId);
                $state['rooms'][$roomId]['roomName'] = sanitizeRoomName($roomId, $input['roomName'] ?? '');
                $state['rooms'][$roomId]['lastUpdatedAt'] = timeMs();
                $state['rooms'][$roomId]['lastUpdatedBy'] = 'Participant';
                return buildRoomPayload($roomId, $state['rooms'][$roomId]);

            default:
                return failPayload('Unknown action');
        }
    });

    if (($response['ok'] ?? false) !== true) {
        http_response_code(400);
    }

    echo json_encode($response, JSON_UNESCAPED_SLASHES);
} catch (Throwable $error) {
    http_response_code(500);
    echo json_encode([
        'ok' => false,
        'error' => 'Server error',
    ], JSON_UNESCAPED_SLASHES);
}

function ensureStorage(string $storageDir, string $stateFile): void
{
    if (!is_dir($storageDir)) {
        mkdir($storageDir, 0775, true);
    }

    if (!file_exists($stateFile)) {
        file_put_contents($stateFile, json_encode(['rooms' => []], JSON_UNESCAPED_SLASHES));
    }
}

function withState(string $stateFile, callable $callback): array
{
    $handle = fopen($stateFile, 'c+');
    if ($handle === false) {
        throw new RuntimeException('Unable to open state file');
    }

    try {
        if (!flock($handle, LOCK_EX)) {
            throw new RuntimeException('Unable to lock state file');
        }

        rewind($handle);
        $raw = stream_get_contents($handle);
        $state = json_decode($raw ?: '{"rooms":[]}', true);
        if (!is_array($state) || !isset($state['rooms']) || !is_array($state['rooms'])) {
            $state = ['rooms' => []];
        }

        $response = $callback($state);

        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($state, JSON_UNESCAPED_SLASHES));
        fflush($handle);
        flock($handle, LOCK_UN);

        return $response;
    } finally {
        fclose($handle);
    }
}

function failPayload(string $message): array
{
    return [
        'ok' => false,
        'error' => $message,
    ];
}

function normalizeRoom($roomId): string
{
    if (!is_string($roomId)) {
        return '';
    }

    $safeRoom = strtolower(trim($roomId));
    $safeRoom = preg_replace('/[^a-z0-9-_]/', '', $safeRoom ?? '');
    return is_string($safeRoom) ? $safeRoom : '';
}

function sanitizeClientId($clientId): string
{
    if (!is_string($clientId)) {
        return '';
    }

    $value = trim($clientId);
    return $value !== '' ? substr($value, 0, 80) : '';
}

function sanitizeRoomName(string $roomId, $value): string
{
    $fallback = 'Room ' . $roomId;
    if (!is_string($value)) {
        return $fallback;
    }

    $normalized = preg_replace('/\s+/', ' ', trim($value));
    if (!is_string($normalized) || $normalized === '') {
        return $fallback;
    }

    return substr($normalized, 0, ROOM_NAME_MAX_LENGTH);
}

function defaultShared(): array
{
    return [
        'title' => '',
        'link' => '',
        'category' => 'general',
        'priority' => 'normal',
        'dueDate' => '',
        'tags' => '',
        'note' => '',
        'text' => '',
        'code' => '',
        'attachments' => [],
    ];
}

function ensureRoomExists(array &$state, string $roomId): void
{
    if (!isset($state['rooms'][$roomId]) || !is_array($state['rooms'][$roomId])) {
        $state['rooms'][$roomId] = [
            'roomName' => sanitizeRoomName($roomId, ''),
            'shared' => defaultShared(),
            'members' => [],
            'lastUpdatedAt' => null,
            'lastUpdatedBy' => 'Participant',
        ];
        return;
    }

    if (!isset($state['rooms'][$roomId]['members']) || !is_array($state['rooms'][$roomId]['members'])) {
        $state['rooms'][$roomId]['members'] = [];
    }
    if (!isset($state['rooms'][$roomId]['shared']) || !is_array($state['rooms'][$roomId]['shared'])) {
        $state['rooms'][$roomId]['shared'] = defaultShared();
    }
    if (!isset($state['rooms'][$roomId]['roomName'])) {
        $state['rooms'][$roomId]['roomName'] = sanitizeRoomName($roomId, '');
    }
}

function generateUniqueRoomCode(array $rooms): string
{
    for ($attempt = 0; $attempt < 200; $attempt++) {
        $code = (string) random_int(100000, 999999);
        if (!isset($rooms[$code])) {
            return $code;
        }
    }

    return substr((string) time(), -6);
}

function touchMember(array &$room, string $clientId): void
{
    $room['members'][$clientId] = [
        'id' => $clientId,
        'label' => 'Member-' . substr($clientId, -4),
        'lastSeenAt' => time(),
    ];
}

function cleanupExpiredMembers(array &$state): void
{
    $now = time();
    foreach ($state['rooms'] as &$room) {
        if (!isset($room['members']) || !is_array($room['members'])) {
            $room['members'] = [];
            continue;
        }

        foreach ($room['members'] as $memberId => $member) {
            $lastSeenAt = isset($member['lastSeenAt']) ? (int) $member['lastSeenAt'] : 0;
            if ($lastSeenAt <= 0 || ($now - $lastSeenAt) > MEMBER_TTL_SECONDS) {
                unset($room['members'][$memberId]);
            }
        }
    }
    unset($room);
}

function getRoomMembers(array $room): array
{
    if (!isset($room['members']) || !is_array($room['members'])) {
        return [];
    }

    $members = array_values($room['members']);
    usort($members, static function (array $left, array $right): int {
        return strcmp((string) ($left['id'] ?? ''), (string) ($right['id'] ?? ''));
    });

    return array_map(static function (array $member): array {
        return [
            'id' => (string) ($member['id'] ?? ''),
            'label' => (string) ($member['label'] ?? 'Member'),
        ];
    }, array_slice($members, 0, 100));
}

function buildRoomPayload(string $roomId, array $room): array
{
    $members = getRoomMembers($room);

    return [
        'ok' => true,
        'room' => $roomId,
        'roomName' => sanitizeRoomName($roomId, $room['roomName'] ?? ''),
        'shared' => isset($room['shared']) && is_array($room['shared']) ? $room['shared'] : defaultShared(),
        'online' => count($members),
        'members' => $members,
        'lastUpdatedAt' => $room['lastUpdatedAt'] ?? null,
        'lastUpdatedBy' => $room['lastUpdatedBy'] ?? 'Participant',
    ];
}

function sanitizeShared(array $current, array $incoming): array
{
    return [
        'title' => sanitizeString($incoming['title'] ?? $current['title'] ?? '', 120),
        'link' => sanitizeString($incoming['link'] ?? $current['link'] ?? '', 300),
        'category' => sanitizeString($incoming['category'] ?? $current['category'] ?? 'general', 40),
        'priority' => sanitizeString($incoming['priority'] ?? $current['priority'] ?? 'normal', 20),
        'dueDate' => sanitizeString($incoming['dueDate'] ?? $current['dueDate'] ?? '', 20),
        'tags' => sanitizeString($incoming['tags'] ?? $current['tags'] ?? '', 200),
        'note' => sanitizeString($incoming['note'] ?? $current['note'] ?? '', 5000),
        'text' => sanitizeString($incoming['text'] ?? $current['text'] ?? '', 60000),
        'code' => sanitizeString($incoming['code'] ?? $current['code'] ?? '', 60000),
        'attachments' => array_key_exists('attachments', $incoming)
            ? sanitizeAttachments($incoming['attachments'])
            : (isset($current['attachments']) && is_array($current['attachments']) ? $current['attachments'] : []),
    ];
}

function sanitizeString($value, int $maxLength): string
{
    if (!is_string($value)) {
        return '';
    }

    return substr($value, 0, $maxLength);
}

function sanitizeAttachments($value): array
{
    if (!is_array($value)) {
        return [];
    }

    $result = [];
    foreach ($value as $item) {
        if (count($result) >= MAX_ATTACHMENTS) {
            break;
        }

        if (!is_array($item)) {
            continue;
        }

        $safe = sanitizeAttachment($item);
        if ($safe !== null) {
            $result[] = $safe;
        }
    }

    return $result;
}

function sanitizeAttachment(array $item): ?array
{
    $dataUrl = isset($item['dataUrl']) && is_string($item['dataUrl']) ? $item['dataUrl'] : '';
    if (strpos($dataUrl, 'data:') !== 0) {
        return null;
    }

    $commaIndex = strpos($dataUrl, ',');
    if ($commaIndex === false) {
        return null;
    }

    $base64Data = substr($dataUrl, $commaIndex + 1);
    if ($base64Data === false || $base64Data === '') {
        return null;
    }

    $approxBytes = (int) floor((strlen($base64Data) * 3) / 4);
    if ($approxBytes > MAX_ATTACHMENT_BYTES) {
        return null;
    }

    return [
        'id' => sanitizeString(is_string($item['id'] ?? null) ? $item['id'] : uniqid('att_', true), 80),
        'name' => sanitizeString(is_string($item['name'] ?? null) ? $item['name'] : 'file', 120),
        'mimeType' => sanitizeString(is_string($item['mimeType'] ?? null) ? $item['mimeType'] : 'application/octet-stream', 80),
        'dataUrl' => $dataUrl,
        'size' => $approxBytes,
        'ownerId' => sanitizeString(is_string($item['ownerId'] ?? null) ? $item['ownerId'] : '', 80),
    ];
}

function findAttachmentIndex(array $attachments, string $attachmentId): int
{
    foreach ($attachments as $index => $attachment) {
        if (($attachment['id'] ?? '') === $attachmentId) {
            return (int) $index;
        }
    }

    return -1;
}

function timeMs(): int
{
    return (int) round(microtime(true) * 1000);
}
