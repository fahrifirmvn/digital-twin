# Ablasi Fase 4 (DEMO, data sintetis)

Perintah: `cd engine && uv run python -u -m scripts.ablation --volume 320 --seeds 3 --scenario all --time-limit 4`

Rata-rata 3 seed (1..3). A = FIFO, B = CP-SAT rata-rata, C = CP-SAT P80, D = C + Monte Carlo + replan bergulir. "X lebih baik dari A" = jumlah seed dengan nilai lebih baik secara ketat (seri tidak dihitung).

### normal

| KPI | A | B | C | D | B lebih baik dari A | C lebih baik dari A | D lebih baik dari A |
|---|---|---|---|---|---|---|---|
| truck_wait_mean | 70.7 | 69.3 | 70.9 | 70.8 | 2/3 | 0/3 | 0/3 |
| truck_wait_p90 | 116.6 | 116.7 | 129.2 | 129.2 | 1/3 | 0/3 | 0/3 |
| tank_dwell_mean | 34.0 | 34.0 | 34.0 | 34.0 | 0/3 | 0/3 | 0/3 |
| changeover_min | 83.3 | 0.0 | 36.7 | 0.0 | 3/3 | 3/3 | 3/3 |
| unscheduled_cip | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| fg_ton | 290.5 | 290.5 | 290.5 | 290.5 | 0/3 | 0/3 | 0/3 |
| held_qa | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| holding_violations | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| schedule_adherence | - | 54.4 | 63.9 | 63.9 | - | - | - |

### truck_surge

| KPI | A | B | C | D | B lebih baik dari A | C lebih baik dari A | D lebih baik dari A |
|---|---|---|---|---|---|---|---|
| truck_wait_mean | 112.8 | 114.4 | 113.2 | 113.8 | 1/3 | 0/3 | 1/3 |
| truck_wait_p90 | 211.9 | 226.4 | 227.2 | 215.7 | 0/3 | 0/3 | 1/3 |
| tank_dwell_mean | 33.9 | 33.9 | 33.9 | 34.0 | 0/3 | 0/3 | 0/3 |
| changeover_min | 276.7 | 270.0 | 310.0 | 120.0 | 1/3 | 0/3 | 3/3 |
| unscheduled_cip | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| fg_ton | 467.8 | 467.8 | 467.8 | 467.8 | 0/3 | 0/3 | 0/3 |
| held_qa | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| holding_violations | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| schedule_adherence | - | 50.1 | 54.0 | 36.1 | - | - | - |

### sterilizer_down

| KPI | A | B | C | D | B lebih baik dari A | C lebih baik dari A | D lebih baik dari A |
|---|---|---|---|---|---|---|---|
| truck_wait_mean | 70.7 | 69.3 | 70.9 | 69.5 | 2/3 | 0/3 | 1/3 |
| truck_wait_p90 | 116.6 | 116.7 | 129.2 | 127.0 | 1/3 | 0/3 | 1/3 |
| tank_dwell_mean | 41.8 | 41.9 | 41.6 | 41.7 | 0/3 | 1/3 | 1/3 |
| changeover_min | 123.3 | 86.7 | 50.0 | 0.0 | 2/3 | 2/3 | 3/3 |
| unscheduled_cip | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| fg_ton | 290.5 | 290.5 | 290.5 | 290.5 | 0/3 | 0/3 | 0/3 |
| held_qa | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| holding_violations | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| schedule_adherence | - | 52.0 | 54.4 | 62.6 | - | - | - |

### cip_delay

| KPI | A | B | C | D | B lebih baik dari A | C lebih baik dari A | D lebih baik dari A |
|---|---|---|---|---|---|---|---|
| truck_wait_mean | 83.2 | 80.1 | 85.0 | 85.0 | 2/3 | 0/3 | 0/3 |
| truck_wait_p90 | 145.6 | 136.3 | 183.5 | 183.5 | 1/3 | 0/3 | 0/3 |
| tank_dwell_mean | 34.1 | 34.1 | 34.1 | 34.1 | 0/3 | 0/3 | 0/3 |
| changeover_min | 73.3 | 0.0 | 23.3 | 0.0 | 3/3 | 3/3 | 3/3 |
| unscheduled_cip | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| fg_ton | 290.5 | 290.5 | 290.5 | 290.5 | 0/3 | 0/3 | 0/3 |
| held_qa | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| holding_violations | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| schedule_adherence | - | 40.7 | 31.4 | 45.7 | - | - | - |

### out_of_spec

| KPI | A | B | C | D | B lebih baik dari A | C lebih baik dari A | D lebih baik dari A |
|---|---|---|---|---|---|---|---|
| truck_wait_mean | 63.7 | 63.7 | 63.7 | 64.1 | 0/3 | 0/3 | 0/3 |
| truck_wait_p90 | 95.9 | 95.9 | 95.9 | 98.2 | 0/3 | 0/3 | 0/3 |
| tank_dwell_mean | 33.5 | 33.5 | 33.5 | 33.5 | 0/3 | 0/3 | 0/3 |
| changeover_min | 0.0 | 13.3 | 13.3 | 0.0 | 0/3 | 0/3 | 0/3 |
| unscheduled_cip | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| fg_ton | 214.1 | 214.1 | 214.1 | 214.1 | 0/3 | 0/3 | 0/3 |
| held_qa | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| holding_violations | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| schedule_adherence | - | 30.0 | 55.2 | 34.4 | - | - | - |

### peak_450

| KPI | A | B | C | D | B lebih baik dari A | C lebih baik dari A | D lebih baik dari A |
|---|---|---|---|---|---|---|---|
| truck_wait_mean | 85.9 | 83.8 | 82.9 | 83.6 | 1/3 | 2/3 | 2/3 |
| truck_wait_p90 | 157.6 | 131.6 | 125.0 | 144.6 | 2/3 | 2/3 | 1/3 |
| tank_dwell_mean | 34.2 | 34.2 | 34.2 | 34.2 | 0/3 | 0/3 | 0/3 |
| changeover_min | 280.0 | 123.3 | 60.0 | 10.0 | 3/3 | 3/3 | 3/3 |
| unscheduled_cip | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| fg_ton | 426.4 | 426.4 | 426.4 | 426.4 | 0/3 | 0/3 | 0/3 |
| held_qa | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| holding_violations | 0.0 | 0.0 | 0.0 | 0.0 | 0/3 | 0/3 | 0/3 |
| schedule_adherence | - | 43.2 | 33.7 | 38.0 | - | - | - |
