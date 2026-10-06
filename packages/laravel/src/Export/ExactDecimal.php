<?php

declare(strict_types=1);

namespace Synloquent\Laravel\Export;

use Synloquent\Laravel\Protocol\ProtocolException;

final class ExactDecimal
{
    public static function scale(string $value, int $precision): string
    {
        if (! preg_match('/^(-?)([0-9]+)(?:\.([0-9]+))?$/D', $value, $parts) || $precision < 0 || $precision > 30) {
            throw new ProtocolException('validation_failed', 'Invalid exact decimal result.');
        }
        $fraction = $parts[3] ?? '';
        $digits = ltrim($parts[2], '0').substr(str_pad($fraction, $precision, '0'), 0, $precision);
        if ($digits === '') {
            $digits = '0';
        }
        if (isset($fraction[$precision]) && $fraction[$precision] >= '5') {
            $carry = 1;
            for ($position = strlen($digits) - 1; $position >= 0 && $carry !== 0; $position--) {
                $digit = (int) $digits[$position] + $carry;
                $digits[$position] = (string) ($digit % 10);
                $carry = intdiv($digit, 10);
            }
            if ($carry !== 0) {
                $digits = '1'.$digits;
            }
        }
        $digits = str_pad($digits, $precision + 1, '0', STR_PAD_LEFT);
        $result = $precision === 0 ? $digits : substr($digits, 0, -$precision).'.'.substr($digits, -$precision);

        return $parts[1] === '-' && preg_match('/[1-9]/', $digits) ? '-'.$result : $result;
    }
}
