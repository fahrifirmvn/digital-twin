<?php

namespace App\Enums;

enum Role: string
{
    case Ppic = 'ppic';
    case Qa = 'qa';
    case Operator = 'operator';
    case Driver = 'driver';
    case Admin = 'admin';
    case Observer = 'observer';

    public function label(): string
    {
        return match ($this) {
            self::Ppic => 'PPIC',
            self::Qa => 'QA/Lab',
            self::Operator => 'Operator produksi',
            self::Driver => 'Sopir tangki',
            self::Admin => 'Admin',
            self::Observer => 'Observer/Juri',
        };
    }
}
