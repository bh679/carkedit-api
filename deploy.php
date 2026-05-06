<?php
/**
 * Deploy endpoint for carkedit-api — triggers git pull + npm ci + build +
 * graceful pm2 reload, with real-time status.
 * Usage: GET /carkedit-api/deploy.php?token=SECRET&branch=main
 *
 * Mirrors carkedit-online/deploy.php so the deploy mechanism is identical
 * across both repos. Differences: build/reload steps after the pull, and the
 * branch-state file lives in the client checkout (shared with branch-info.php).
 *
 * Writes deploy-status.json next to this file at each step.
 * Optional: &branch=<name> to deploy a specific branch (default: main).
 */

header('Content-Type: application/json');

const REPO_DIR    = '/home/bitnami/server/carkedit-api';
const STATE_FILE  = '/opt/bitnami/apache/htdocs/carkedit-online/branch-state.json';
const TOKEN_FILE  = '/home/bitnami/server/.deploy-token-carkedit-api';
const PM2_APP     = 'carkedit-api';

$statusFile = __DIR__ . '/deploy-status.json';
$maxHistory = 10;

/* ------------------------------------------------------------------ */
/*  Status file helpers                                                */
/* ------------------------------------------------------------------ */

function readStatus($file) {
    if (!is_readable($file)) {
        return ['deploying' => false, 'history' => []];
    }
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : ['deploying' => false, 'history' => []];
}

function writeStatus($file, $data) {
    file_put_contents($file, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
}

function addStep(&$status, $name, $stepStatus = 'active') {
    if (isset($status['steps'])) {
        foreach ($status['steps'] as &$s) {
            if ($s['status'] === 'active') {
                $s['status'] = 'done';
            }
        }
        unset($s);
    }
    $status['steps'][] = [
        'name'   => $name,
        'time'   => gmdate('c'),
        'status' => $stepStatus,
    ];
    $status['currentStep'] = $name;
}

function startDeploy($file, $target, $maxHistory) {
    $prev = readStatus($file);
    $status = [
        'deploying'   => true,
        'target'      => $target,
        'startedAt'   => gmdate('c'),
        'currentStep' => 'starting',
        'steps'       => [
            ['name' => 'starting', 'time' => gmdate('c'), 'status' => 'active'],
        ],
        'history'     => $prev['history'] ?? [],
    ];
    writeStatus($file, $status);
    return $status;
}

function completeDeploy($file, &$status, $success, $maxHistory) {
    addStep($status, 'complete', $success ? 'done' : 'error');
    $status['deploying'] = false;

    $historyEntry = [
        'target'      => $status['target'],
        'startedAt'   => $status['startedAt'],
        'completedAt' => gmdate('c'),
        'duration'    => time() - strtotime($status['startedAt']),
        'status'      => $success ? 'success' : 'failed',
    ];
    array_unshift($status['history'], $historyEntry);
    $status['history'] = array_slice($status['history'], 0, $maxHistory);

    writeStatus($file, $status);
}

/* ------------------------------------------------------------------ */
/*  Run a single shell command and capture output                      */
/* ------------------------------------------------------------------ */

function runCmd($cmd) {
    $output = [];
    $rc = 0;
    exec($cmd . ' 2>&1', $output, $rc);
    return ['output' => $output, 'rc' => $rc];
}

/* ------------------------------------------------------------------ */
/*  Token validation                                                   */
/* ------------------------------------------------------------------ */

if (!is_readable(TOKEN_FILE)) {
    http_response_code(500);
    echo json_encode(['error' => 'Deploy token not readable']);
    exit;
}
$expectedToken = trim(file_get_contents(TOKEN_FILE));
if (strlen($expectedToken) === 0) {
    http_response_code(500);
    echo json_encode(['error' => 'Deploy token is empty']);
    exit;
}

$providedToken = $_GET['token'] ?? '';
if (strlen($providedToken) === 0 || !hash_equals($expectedToken, $providedToken)) {
    http_response_code(403);
    echo json_encode(['error' => 'Forbidden']);
    exit;
}

/* ------------------------------------------------------------------ */
/*  Branch validation                                                  */
/* ------------------------------------------------------------------ */

$branch = $_GET['branch'] ?? 'main';
if (!preg_match('/^[a-zA-Z0-9_\-\.\/]+$/', $branch)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid branch name']);
    exit;
}

/* ------------------------------------------------------------------ */
/*  Branch-state check: only deploy if this is the active branch       */
/*  STATE_FILE is shared with the client (branch-info.php reads it).   */
/* ------------------------------------------------------------------ */

$branchState = is_readable(STATE_FILE) ? json_decode(file_get_contents(STATE_FILE), true) : [];
if (!is_array($branchState)) $branchState = [];
$deployedBranch = $branchState['api'] ?? 'main';

if ($branch !== $deployedBranch) {
    // If pushing main and the deployed branch was deleted (e.g. merged PR), fall back to main
    $branchGone = false;
    if ($branch === 'main' && $deployedBranch !== 'main') {
        $checkResult = runCmd('sudo -u bitnami bash -c "cd ' . escapeshellarg(REPO_DIR) . ' && git ls-remote --heads origin ' . escapeshellarg($deployedBranch) . '"');
        $branchGone = empty(trim(implode('', $checkResult['output'])));
    }

    if (!$branchGone) {
        echo json_encode([
            'status'  => 'skipped',
            'message' => "Pushed branch '$branch' doesn't match deployed branch '$deployedBranch'",
            'target'  => 'api',
            'branch'  => $branch,
        ]);
        exit;
    }
    // Deployed branch was deleted — fall back to deploying main
    $branch = 'main';
}

/* ------------------------------------------------------------------ */
/*  Deploy with step-by-step status                                    */
/* ------------------------------------------------------------------ */

$status = startDeploy($statusFile, 'api', $maxHistory);
$allOutput = [];
$failed = false;
$escapedBranch = escapeshellarg($branch);
$escapedRepo   = escapeshellarg(REPO_DIR);

// Step 1 — Pull API code
addStep($status, 'pulling-api');
writeStatus($statusFile, $status);
$result = runCmd('sudo -u bitnami bash -c "cd ' . $escapedRepo . ' && git fetch origin && git checkout ' . $escapedBranch . ' && git reset --hard origin/' . $escapedBranch . '"');
$allOutput = array_merge($allOutput, $result['output']);
if ($result['rc'] !== 0) {
    $failed = true;
}

// Step 2 — Install dependencies
if (!$failed) {
    addStep($status, 'installing-deps');
    writeStatus($statusFile, $status);
    $result = runCmd('sudo -u bitnami bash -c "cd ' . $escapedRepo . ' && npm ci"');
    $allOutput = array_merge($allOutput, $result['output']);
    if ($result['rc'] !== 0) {
        $failed = true;
    }
}

// Step 3 — Build
if (!$failed) {
    addStep($status, 'building');
    writeStatus($statusFile, $status);
    $result = runCmd('sudo -u bitnami bash -c "cd ' . $escapedRepo . ' && npm run build"');
    $allOutput = array_merge($allOutput, $result['output']);
    if ($result['rc'] !== 0) {
        $failed = true;
    }
}

// Step 4 — Graceful PM2 reload (zero-downtime; preserves --env)
if (!$failed) {
    addStep($status, 'reloading');
    writeStatus($statusFile, $status);
    $result = runCmd('sudo -u bitnami pm2 reload ' . escapeshellarg(PM2_APP));
    $allOutput = array_merge($allOutput, $result['output']);
    if ($result['rc'] !== 0) {
        $failed = true;
    }
}

// Update shared branch state on success
if (!$failed) {
    $branchState = is_readable(STATE_FILE) ? json_decode(file_get_contents(STATE_FILE), true) : [];
    if (!is_array($branchState)) $branchState = [];
    $branchState['api'] = $branch;
    $branchState['apiUpdatedAt'] = gmdate('c');
    file_put_contents(STATE_FILE, json_encode($branchState, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
}

// Finalize
completeDeploy($statusFile, $status, !$failed, $maxHistory);

// Return response
if ($failed) {
    http_response_code(500);
    echo json_encode([
        'status' => 'error',
        'target' => 'api',
        'branch' => $branch,
        'output' => array_values(array_filter($allOutput)),
    ]);
} else {
    echo json_encode([
        'status' => 'ok',
        'target' => 'api',
        'branch' => $branch,
        'output' => array_values(array_filter($allOutput)),
    ]);
}
