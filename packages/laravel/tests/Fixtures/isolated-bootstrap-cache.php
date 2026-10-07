<?php

declare(strict_types=1);

$bootstrapCacheDirectory = dirname(__DIR__, 4).'/.agentic/artifacts/test-bootstrap-cache/'.getmypid().'-'.bin2hex(random_bytes(8));
if (! mkdir($bootstrapCacheDirectory, 0700, true)) {
    throw new RuntimeException('Could not create isolated test bootstrap cache directory.');
}
$cleanupBootstrapCaches = static function () use ($bootstrapCacheDirectory): void {
    foreach (['services.php', 'packages.php'] as $filename) {
        $cachePath = $bootstrapCacheDirectory.'/'.$filename;
        if (is_file($cachePath)) {
            unlink($cachePath);
        }
    }
    if (is_dir($bootstrapCacheDirectory)) {
        rmdir($bootstrapCacheDirectory);
    }
};
register_shutdown_function($cleanupBootstrapCaches);
foreach (['APP_SERVICES_CACHE' => 'services.php', 'APP_PACKAGES_CACHE' => 'packages.php'] as $variable => $filename) {
    $cachePath = $bootstrapCacheDirectory.'/'.$filename;
    putenv($variable.'='.$cachePath);
    $_ENV[$variable] = $cachePath;
    $_SERVER[$variable] = $cachePath;
}

return $cleanupBootstrapCaches;
