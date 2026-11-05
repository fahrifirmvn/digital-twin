<?php

namespace Tests\Unit;

use App\Support\AssetLabel;
use PHPUnit\Framework\TestCase;

class AssetLabelTest extends TestCase
{
    public function test_maps_internal_codes_to_brief_nomenclature(): void
    {
        $this->assertSame('ST-01', AssetLabel::alias('TK-RAW-1'));
        $this->assertSame('ST-15', AssetLabel::alias('TK-RAW-15'));
        $this->assertSame('SFP-03', AssetLabel::alias('TK-STO-3'));
        $this->assertSame('UB-02', AssetLabel::alias('BAY-2'));
        $this->assertSame('TH-01', AssetLabel::alias('THM-1'));
        $this->assertSame('ST-STER-04', AssetLabel::alias('STE-4'));
        $this->assertSame('AT-02', AssetLabel::alias('ASEP-2'));
        $this->assertSame('FL-05', AssetLabel::alias('LINE-5'));
        $this->assertNull(AssetLabel::alias('DEG-1'));
        $this->assertSame('ST-01 (TK-RAW-1)', AssetLabel::dual('TK-RAW-1'));
        $this->assertSame('DEG-1', AssetLabel::dual('DEG-1'));
    }
}
