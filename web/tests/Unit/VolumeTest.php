<?php

namespace Tests\Unit;

use App\Support\Volume;
use PHPUnit\Framework\TestCase;

class VolumeTest extends TestCase
{
    public function test_ton_is_converted_to_liters_with_milk_density(): void
    {
        $this->assertSame(971, Volume::liters(1));
        $this->assertSame('14.563 L', Volume::l(15));
        $this->assertSame('0 L', Volume::l(0));
    }
}
