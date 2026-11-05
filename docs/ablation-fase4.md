# Ablasi Fase 4 (DEMO, data sintetis)

Perintah: `cd engine && uv run python -u -m scripts.ablation --volume 320 --seeds 3 --scenario all --time-limit 1.5`

Rata-rata 3 seed (1..3). A = FIFO, B = CP-SAT rata-rata, C = CP-SAT P80, D = C + Monte Carlo + replan bergulir. "X lebih baik dari A" = jumlah seed dengan nilai lebih baik secara ketat (seri tidak dihitung).

### normal

| KPI | A | B | C | D | B lebih baik dari A | C lebih baik dari A | D lebih baik dari A |
|---|---|---|---|---|---|---|---|
| truck_wait_mean | 71.1 | 71.1 | 71.2 | 71.2 | 0/3 | 0/3 | 0/3 |
| truck_wait_p90 | 112.0 | 112.0 | 112.0 | 112.0 | 0/3 | 0/3 | 0/3 |
| tank_dwell_mean | 33.6 | 33.6 | 33.6 | 33.6 | 0/3 | 0/3 | 0/3 |
| changeover_min | 113.3 | 53.3 | 20.0 | 0.0 | 3/3 | 3/3 | 3/3 |
| unscheduled_cip | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| fg_ton | 295.4 | 295.4 | 295.4 | 295.4 | 0/3 | 0/3 | 0/3 |
| held_qa | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| holding_violations | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| schedule_adherence | - | 45.4 | 30.6 | 27.7 | - | - | - |
| solve_seconds | - | 5.2 | 6.0 | 4.0 | - | - | - |
| replan_changes | - | - | - | 23.3 | - | - | - |

### truck_surge

| KPI | A | B | C | D | B lebih baik dari A | C lebih baik dari A | D lebih baik dari A |
|---|---|---|---|---|---|---|---|
| truck_wait_mean | 99.5 | 99.4 | 98.9 | 97.4 | 1/3 | 1/3 | 3/3 |
| truck_wait_p90 | 172.0 | 172.0 | 172.0 | 191.7 | 0/3 | 0/3 | 1/3 |
| tank_dwell_mean | 33.7 | 33.7 | 33.7 | 33.7 | 0/3 | 0/3 | 1/3 |
| changeover_min | 446.7 | 373.3 | 350.0 | 53.3 | 2/3 | 3/3 | 3/3 |
| unscheduled_cip | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| fg_ton | 472.7 | 472.7 | 472.7 | 472.7 | 0/3 | 0/3 | 0/3 |
| held_qa | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| holding_violations | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| schedule_adherence | - | 35.2 | 30.6 | 33.1 | - | - | - |
| solve_seconds | - | 5.1 | 6.0 | 4.0 | - | - | - |
| replan_changes | - | - | - | 64.0 | - | - | - |

### sterilizer_down

| KPI | A | B | C | D | B lebih baik dari A | C lebih baik dari A | D lebih baik dari A |
|---|---|---|---|---|---|---|---|
| truck_wait_mean | 71.1 | 71.1 | 71.2 | 71.2 | 0/3 | 0/3 | 0/3 |
| truck_wait_p90 | 112.0 | 112.0 | 112.0 | 112.0 | 0/3 | 0/3 | 0/3 |
| tank_dwell_mean | 40.6 | 40.6 | 40.6 | 40.6 | 0/3 | 0/3 | 0/3 |
| changeover_min | 120.0 | 100.0 | 100.0 | 53.3 | 2/3 | 2/3 | 2/3 |
| unscheduled_cip | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| fg_ton | 295.4 | 295.4 | 295.4 | 295.4 | 0/3 | 0/3 | 0/3 |
| held_qa | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| holding_violations | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| schedule_adherence | - | 50.7 | 33.3 | 35.0 | - | - | - |
| solve_seconds | - | 5.3 | 6.0 | 4.0 | - | - | - |
| replan_changes | - | - | - | 33.0 | - | - | - |

### cip_delay

| KPI | A | B | C | D | B lebih baik dari A | C lebih baik dari A | D lebih baik dari A |
|---|---|---|---|---|---|---|---|
| truck_wait_mean | 71.1 | 71.1 | 71.2 | 71.2 | 0/3 | 0/3 | 0/3 |
| truck_wait_p90 | 112.0 | 112.0 | 112.0 | 112.0 | 0/3 | 0/3 | 0/3 |
| tank_dwell_mean | 33.6 | 33.6 | 33.6 | 33.6 | 0/3 | 0/3 | 0/3 |
| changeover_min | 113.3 | 53.3 | 20.0 | 0.0 | 3/3 | 3/3 | 3/3 |
| unscheduled_cip | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| fg_ton | 295.4 | 295.4 | 295.4 | 295.4 | 0/3 | 0/3 | 0/3 |
| held_qa | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| holding_violations | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| schedule_adherence | - | 45.4 | 30.6 | 25.1 | - | - | - |
| solve_seconds | - | 5.7 | 6.0 | 4.0 | - | - | - |
| replan_changes | - | - | - | 21.7 | - | - | - |

### out_of_spec

| KPI | A | B | C | D | B lebih baik dari A | C lebih baik dari A | D lebih baik dari A |
|---|---|---|---|---|---|---|---|
| truck_wait_mean | 64.4 | 64.4 | 64.5 | 64.5 | 0/3 | 0/3 | 0/3 |
| truck_wait_p90 | 84.6 | 84.6 | 87.0 | 85.8 | 0/3 | 0/3 | 0/3 |
| tank_dwell_mean | 33.9 | 33.9 | 33.9 | 33.9 | 0/3 | 0/3 | 0/3 |
| changeover_min | 10.0 | 46.7 | 0.0 | 0.0 | 0/3 | 1/3 | 1/3 |
| unscheduled_cip | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| fg_ton | 238.0 | 238.0 | 238.0 | 238.0 | 0/3 | 0/3 | 0/3 |
| held_qa | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| holding_violations | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| schedule_adherence | - | 31.2 | 37.3 | 35.5 | - | - | - |
| solve_seconds | - | 4.4 | 4.3 | 3.1 | - | - | - |
| replan_changes | - | - | - | 29.0 | - | - | - |

### peak_450

| KPI | A | B | C | D | B lebih baik dari A | C lebih baik dari A | D lebih baik dari A |
|---|---|---|---|---|---|---|---|
| truck_wait_mean | 83.9 | 83.9 | 83.6 | 84.5 | 0/3 | 2/3 | 1/3 |
| truck_wait_p90 | 125.6 | 125.6 | 130.0 | 139.2 | 0/3 | 0/3 | 0/3 |
| tank_dwell_mean | 33.9 | 33.9 | 33.9 | 33.8 | 0/3 | 1/3 | 1/3 |
| changeover_min | 273.3 | 133.3 | 193.3 | 30.0 | 2/3 | 2/3 | 3/3 |
| unscheduled_cip | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| fg_ton | 423.5 | 423.5 | 423.5 | 423.5 | 0/3 | 0/3 | 0/3 |
| held_qa | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| holding_violations | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| schedule_adherence | - | 45.5 | 21.1 | 28.3 | - | - | - |
| solve_seconds | - | 6.0 | 6.1 | 3.6 | - | - | - |
| replan_changes | - | - | - | 40.0 | - | - | - |

---

## Analisis Sensitivitas Parameter Placeholder ("X")

Perintah: `cd engine && uv run python -m scripts.sensitivity`

Rata-rata 3 seed (`1..3`, volume `320` ton). Mengukur sensitivitas KPI terhadap parameter operasional placeholder mitra (`cip_min_minutes`–`cip_max_minutes`, `holding_max_min`, dan `n_bays`):

### Sensitivitas: Durasi CIP (`cip_min_minutes` - `cip_max_minutes`)

| Nilai Parameter | Konfig | Tunggu Rata-rata (mnt) | Tunggu P90 (mnt) | Dwell Tangki (mnt) | Changeover (mnt) | Pelanggaran Holding | FG Keluar (ton) |
|---|---|---:|---:|---:|---:|---:|---:|
| 45-60 mnt (-25%) | A | 71.1 | 112.0 | 33.6 | 113.3 | 0.0 | 295.4 |
| 45-60 mnt (-25%) | C | 71.2 | 112.0 | 33.6 | 20.0 | 0.0 | 295.4 |
| 60-90 mnt (baseline) | A | 71.1 | 112.0 | 33.6 | 113.3 | 0.0 | 295.4 |
| 60-90 mnt (baseline) | C | 71.2 | 112.0 | 33.6 | 20.0 | 0.0 | 295.4 |
| 90-120 mnt (+33%) | A | 71.1 | 112.0 | 33.6 | 113.3 | 0.0 | 295.4 |
| 90-120 mnt (+33%) | C | 71.2 | 112.0 | 33.6 | 20.0 | 0.0 | 295.4 |

### Sensitivitas: Batas Holding Time G4 (`holding_max_min`)

| Nilai Parameter | Konfig | Tunggu Rata-rata (mnt) | Tunggu P90 (mnt) | Dwell Tangki (mnt) | Changeover (mnt) | Pelanggaran Holding | FG Keluar (ton) |
|---|---|---:|---:|---:|---:|---:|---:|
| 120 mnt (-50%) | A | 71.1 | 112.0 | 33.6 | 113.3 | 0.0 | 295.4 |
| 120 mnt (-50%) | C | 71.2 | 112.0 | 33.6 | 20.0 | 0.0 | 295.4 |
| 240 mnt (baseline) | A | 71.1 | 112.0 | 33.6 | 113.3 | 0.0 | 295.4 |
| 240 mnt (baseline) | C | 71.2 | 112.0 | 33.6 | 20.0 | 0.0 | 295.4 |
| 360 mnt (+50%) | A | 71.1 | 112.0 | 33.6 | 113.3 | 0.0 | 295.4 |
| 360 mnt (+50%) | C | 71.2 | 112.0 | 33.6 | 33.3 | 0.0 | 295.4 |

### Sensitivitas: Jumlah Unloading Bay (`n_bays`)

| Nilai Parameter | Konfig | Tunggu Rata-rata (mnt) | Tunggu P90 (mnt) | Dwell Tangki (mnt) | Changeover (mnt) | Pelanggaran Holding | FG Keluar (ton) |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 bay | A | 83.1 | 124.0 | 33.6 | 123.3 | 0.0 | 295.4 |
| 1 bay | C | 83.2 | 124.0 | 33.6 | 36.7 | 0.0 | 295.4 |
| 2 bay | A | 71.1 | 112.0 | 33.6 | 113.3 | 0.0 | 295.4 |
| 2 bay | C | 71.2 | 112.0 | 33.6 | 33.3 | 0.0 | 295.4 |
| 3 bay (baseline) | A | 71.1 | 112.0 | 33.6 | 113.3 | 0.0 | 295.4 |
| 3 bay (baseline) | C | 71.2 | 112.0 | 33.6 | 20.0 | 0.0 | 295.4 |
