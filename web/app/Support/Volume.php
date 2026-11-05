<?php

namespace App\Support;

// Engine bekerja dalam ton; layar menampilkan liter. Massa jenis susu standar brief 1,0 kg/L, jadi 1 ton = 1.000 L.
final class Volume
{
    public const L_PER_TON = 1000.0;

    public static function liters(float|int|string|null $ton): int
    {
        return (int) round((float) $ton * self::L_PER_TON);
    }

    /** 22.5 (ton) -> "22.500 L" */
    public static function l(float|int|string|null $ton): string
    {
        return number_format(self::liters($ton), 0, ',', '.').' L';
    }
}
