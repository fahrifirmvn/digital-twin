<?php

namespace App\Support;

/**
 * Pemetaan nomenklatur aset internal Engine ke kode standar brief mitra:
 * - BAY-k    -> UB-0k (Unloading Bay)
 * - TK-RAW-k -> ST-0k..15 (Storage Tank receiving)
 * - TK-STO-k -> SFP-0k (SFP Storage)
 * - THM-k    -> TH-0k (Thermizer)
 * - STE-k    -> ST-STER-0k (Sterilizer UHT)
 * - ASEP-k   -> AT-0k (Aseptic Tank)
 * - LINE-k   -> FL-0k..10 (Filling Line)
 */
final class AssetLabel
{
    private const PREFIXES = [
        'BAY' => 'UB',
        'TK-RAW' => 'ST',
        'TK-STO' => 'SFP',
        'THM' => 'TH',
        'STE' => 'ST-STER',
        'ASEP' => 'AT',
        'LINE' => 'FL',
    ];

    public static function alias(string $code): ?string
    {
        if (! preg_match('/^(BAY|TK-RAW|TK-STO|THM|STE|ASEP|LINE)-(\d+)$/', $code, $m)) {
            return null;
        }
        $prefix = self::PREFIXES[$m[1]] ?? null;
        if ($prefix === null) {
            return null;
        }

        return sprintf('%s-%02d', $prefix, (int) $m[2]);
    }

    public static function dual(string $code): string
    {
        $alias = self::alias($code);

        return $alias !== null ? "{$alias} ({$code})" : $code;
    }
}
