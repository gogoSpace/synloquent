<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Protocol;

use Generator;

final class CatalogReader
{
    /** @return Generator<int, array{section: string, encoded: string}, mixed, void> */
    public function rows(string $content): Generator
    {
        $offset = 0;
        foreach (['records' => '{"records":[', 'relationSets' => ',"relationSets":['] as $section => $prefix) {
            $this->consume($content, $offset, $prefix);
            $first = true;
            while (($content[$offset] ?? null) !== ']') {
                if (! $first) {
                    $this->consume($content, $offset, ',');
                }
                $first = false;
                $start = $offset;
                $this->consume($content, $offset, '{');
                $depth = 1;
                while ($depth > 0) {
                    $offset += strcspn($content, '{}[]"', $offset);
                    $token = $content[$offset] ?? null;
                    if ($token === null) {
                        throw new ProtocolException('invalid_snapshot', 'Catalog row is truncated.');
                    }
                    $offset++;
                    if ($token === '"') {
                        while (true) {
                            $offset += strcspn($content, '"\\', $offset);
                            $character = $content[$offset] ?? null;
                            if ($character === null) {
                                throw new ProtocolException('invalid_snapshot', 'Catalog string is truncated.');
                            }
                            $offset++;
                            if ($character === '"') {
                                break;
                            }
                            $offset++;
                        }
                    } elseif ($token === '{' || $token === '[') {
                        $depth++;
                    } else {
                        $depth--;
                    }
                }
                yield ['section' => $section, 'encoded' => substr($content, $start, $offset - $start)];
            }
            $offset++;
        }
        $this->consume($content, $offset, '}');
        if ($offset !== strlen($content)) {
            throw new ProtocolException('invalid_snapshot', 'Catalog has trailing content.');
        }
    }

    private function consume(string $content, int &$offset, string $expected): void
    {
        if (substr_compare($content, $expected, $offset, strlen($expected)) !== 0) {
            throw new ProtocolException('invalid_snapshot', 'Catalog structure is invalid.');
        }
        $offset += strlen($expected);
    }
}
