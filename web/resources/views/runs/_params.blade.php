{{-- Parameter operasional per run (P9/Q1). Nilai demo, bukan SOP. Hanya PPIC dan admin. "Uji ulang" menjalankan A dan B. --}}
@can('run-scenario')
@php
    $fields = config('twin.params.fields');
    $maint = config('twin.params.maintenance');
    $cur = $run->config_snapshot['params']['params'] ?? [];
    $steCount = $run->config_snapshot['params']['plant']['n_sterilizers'] ?? 5;
    $rows = array_values($cur['maintenance'] ?? []);
    $clockOf = fn ($m) => sprintf('%02d:%02d', intdiv(((int) $m + 360) % 1440, 60), ((int) $m + 360) % 60);
    $custom = count(array_diff_key($cur, ['maintenance' => 1, 'orders' => 1])) + count($rows) + count($cur['orders'] ?? []);
@endphp
<details class="tw-card" id="params" @if ($errors->any()) open @endif>
    <summary><b>Parameter operasional</b> <span class="muted">{{ $custom ? "$custom diubah dari bawaan" : 'nilai bawaan' }} (nilai demo, bukan SOP)</span></summary>
    <form method="POST" action="{{ route('runs.retest', $run) }}" id="retest-form">
        @csrf
        @if ($errors->any())
            <div class="tw-card err" role="alert">@foreach ($errors->all() as $e)<div>{{ $e }}</div>@endforeach</div>
        @endif
        <p class="muted">Hari yang sama (seed {{ $run->seed }}, volume, skenario, dan pabrik tetap). Uji ulang menjalankan A (FIFO) dan B (CP-SAT) dengan parameter ini, lalu membuka perbandingannya.</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0 12px;">
            <small class="muted"><b>Preset Uji Cepat PPIC:</b></small>
            <button type="button" class="tw-btn" onclick="(function(f){f.querySelector('[name=&quot;params[orders][0][sku]&quot;]').value='UHT-CHOC-200';f.querySelector('[name=&quot;params[orders][0][ton]&quot;]').value='80';f.querySelector('[name=&quot;params[orders][1][sku]&quot;]').value='UHT-FULL-1000';f.querySelector('[name=&quot;params[orders][1][ton]&quot;]').value='120';})(this.form)"><span>Lonjakan Order Cokelat (80 t)</span></button>
            <button type="button" class="tw-btn" onclick="(function(f){f.querySelector('[name=&quot;params[maintenance][0][asset]&quot;]').value='STE-1';f.querySelector('[name=&quot;params[maintenance][0][start_clock]&quot;]').value='08:00';f.querySelector('[name=&quot;params[maintenance][0][duration_min]&quot;]').value='120';})(this.form)"><span>Maintenance STE-1 (08:00 · 120 mnt)</span></button>
            <button type="button" class="tw-btn" onclick="(function(f){var h=f.querySelector('#p-holding_max_min');if(h)h.value='180';var p=f.querySelector('#p-sku-policy');if(p)p.value='dedicated';})(this.form)"><span>Holding Ketat (180 mnt) + Dedicated Line</span></button>
        </div>
        <div class="param-groups">
            @foreach (collect($fields)->groupBy('group', true) as $group => $items)
                <fieldset class="param-group">
                    <legend>{{ $group }}</legend>
                    @foreach ($items as $key => $f)
                        <div class="param-row">
                            <label for="p-{{ $key }}">{{ $f['label'] }}<small>{{ $f['min'] }} sampai {{ $f['max'] }}, bawaan {{ $f['default'] }}</small></label>
                            <span class="param-input"><input id="p-{{ $key }}" type="number" name="params[{{ $key }}]" value="{{ old("params.$key", $cur[$key] ?? $f['default']) }}" min="{{ $f['min'] }}" max="{{ $f['max'] }}" step="{{ $f['step'] }}"><span>{{ $f['unit'] }}</span></span>
                        </div>
                    @endforeach
                </fieldset>
            @endforeach
        </div>

        @php
            $pol = config('twin.params.sku_policy');
            $polNow = old('params.sku_policy', $cur['sku_policy'] ?? $pol['default']);
        @endphp
        <h2>Izin SKU per line</h2>
        <p class="muted">Menentukan SKU mana yang boleh diisi di tiap filling line. Matriks AT-FL-SKU terlihat di panel aset Twin (ASEP, LINE).</p>
        <select id="p-sku-policy" name="params[sku_policy]" aria-label="Kebijakan izin SKU">
            @foreach ($pol['options'] as $val => $label)
                <option value="{{ $val }}" @selected($polNow === $val)>{{ $label }}</option>
            @endforeach
        </select>

        @php
            $ord = config('twin.params.orders');
            $orderRows = array_values($cur['orders'] ?? []);
        @endphp
        <h2>Order produksi</h2>
        <p class="muted">Kosongkan semua baris untuk order otomatis (susu terjadwal per SKU). Jumlah dalam ton produk jadi; kebutuhan susu mengikuti persen pemakaian susu di atas. Maksimal {{ $ord['max'] }}.</p>
        <div class="tw-table-scroll" tabindex="0" aria-label="Order produksi, dapat digulir">
            <table>
                <thead><tr><th>SKU</th><th>Jumlah (t)</th></tr></thead>
                <tbody>
                @for ($i = 0; $i < 3; $i++)
                    @php($r = $orderRows[$i] ?? null)
                    <tr>
                        <td>
                            <select name="params[orders][{{ $i }}][sku]" aria-label="SKU order {{ $i + 1 }}">
                                <option value="">-</option>
                                @foreach ($ord['skus'] as $code => $label)
                                    <option value="{{ $code }}" @selected(old("params.orders.$i.sku", $r['sku'] ?? '') === $code)>{{ $label }}</option>
                                @endforeach
                            </select>
                        </td>
                        <td><input type="number" name="params[orders][{{ $i }}][ton]" value="{{ old("params.orders.$i.ton", $r['ton'] ?? '') }}" min="{{ $ord['min_ton'] }}" max="{{ $ord['max_ton'] }}" step="0.5" aria-label="Jumlah order {{ $i + 1 }} (ton)"></td>
                    </tr>
                @endfor
                </tbody>
            </table>
        </div>

        <h2>Maintenance sterilizer terjadwal</h2>
        <p class="muted">Sterilizer tidak tersedia pada jam yang dipilih (hari operasi 06:00 sampai 06:00). Kosongkan baris yang tidak dipakai. Maksimal {{ $maint['max'] }}.</p>
        <div class="tw-table-scroll" tabindex="0" aria-label="Jendela maintenance, dapat digulir">
            <table>
                <thead><tr><th>Sterilizer</th><th>Mulai (jam)</th><th>Durasi (menit)</th></tr></thead>
                <tbody>
                @for ($i = 0; $i < 3; $i++)
                    @php($r = $rows[$i] ?? null)
                    <tr>
                        <td>
                            <select name="params[maintenance][{{ $i }}][asset]" aria-label="Sterilizer baris {{ $i + 1 }}">
                                <option value="">-</option>
                                @for ($k = 1; $k <= $steCount; $k++)
                                    <option value="STE-{{ $k }}" @selected(old("params.maintenance.$i.asset", $r['asset'] ?? '') === "STE-$k")>STE-{{ $k }}</option>
                                @endfor
                            </select>
                        </td>
                        <td><input type="time" name="params[maintenance][{{ $i }}][start_clock]" value="{{ old("params.maintenance.$i.start_clock", $r ? $clockOf($r['start_min']) : '') }}" aria-label="Jam mulai baris {{ $i + 1 }}"></td>
                        <td><input type="number" name="params[maintenance][{{ $i }}][duration_min]" value="{{ old("params.maintenance.$i.duration_min", $r['duration_min'] ?? '') }}" min="{{ $maint['min_duration'] }}" max="{{ $maint['max_duration'] }}" step="5" aria-label="Durasi baris {{ $i + 1 }}"></td>
                    </tr>
                @endfor
                </tbody>
            </table>
        </div>
        <div class="param-submit"><button type="submit" class="tw-btn primary" data-icon="layers" data-icon-size="18"><span>Uji ulang A dan B</span></button></div>
    </form>
</details>
@endcan
