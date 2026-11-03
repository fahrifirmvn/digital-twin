@if (auth()->user()->can('approve-schedule'))
<dialog id="approval" style="border:0;border-radius:8px;padding:20px;max-width:480px;width:90%">
    <form id="approval-form" method="POST">
        @csrf
        <h3 id="approval-title">Setujui jadwal</h3>
        <p id="approval-rationale" class="muted"></p>
        <label for="approval-reason">Alasan persetujuan (wajib, min. 5 karakter)</label>
        <textarea id="approval-reason" name="reason" required minlength="5" maxlength="500" rows="3" style="width:100%;box-sizing:border-box"></textarea>
        <p class="muted" style="font-size:12px">Versi ini menjadi jadwal aktif dan keputusan dicatat ke audit log. Gate G1-G6 tetap berlaku.</p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
            <button type="button" id="approval-cancel">Batal</button>
            <button type="submit">Setujui</button>
        </div>
    </form>
</dialog>
@endif
