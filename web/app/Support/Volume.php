<?php

namespace App\Support;

// Engine bekerja dalam ton; layar menampilkan liter. Massa jenis susu 1,03 kg/L, jadi 1 ton = 1000/1,03 L (~970,87).
final class Volume
{
    public const L_PER_TON = 1000 / 1.03;

    public static function liters(float|int|string|null $ton): int
    {
        return (int) round((float) $ton * self::L_PER_TON);
    }

    /** 22.5 (ton) -> "21.845 L" */
    public static function l(float|int|string|null $ton): string
    {
        return number_format(self::liters($ton), 0, ',', '.').' L';
    }
}
