# TV Hardware Specifications

Low-level hardware reference for the LG webOS TVs tested with this project.
All data gathered from the live TVs via root shell access.

---

## LG OLED65B8SLC (2018 — webOS 4)

| Detail | Value |
|---|---|
| **Model** | OLED65B8SLC |
| **Firmware** | 05.50.70 |
| **webOS** | 4.4.3-22 (codename `goldilocks-gorongosa`) |
| **Kernel** | Linux 4.4.84-150.glacier.2 (armv7l, SMP PREEMPT) |
| **SoC** | LG1313 rev.C0 (AArch32) |

### CPU

| Detail | Value |
|---|---|
| **Architecture** | ARMv7 — Cortex-A53 (CPU part `0xd03`) |
| **Cores** | 4 (hotplug parks idle cores — typically 3 online) |
| **Frequency steps** | 600 MHz, 1008 MHz |
| **Governor** | `performance` (locked at 1008 MHz) |
| **Available governors** | conservative, ondemand, userspace, powersave, performance |
| **Scaling driver** | cpufreq-dt |
| **Transition latency** | 50 µs |
| **BogoMIPS** | 48.00 per core |

### GPU

| Detail | Value |
|---|---|
| **GPU** | Mali-T820 MP2 (r1p0, ID `0x0820`) |
| **Shader cores** | 2 (core mask `0x3`) |
| **Power policy** | `demand` (available: always_on, coarse_demand) |
| **DVFS period** | 100 ms |
| **Clock control** | Not exposed via sysfs or debugfs |

### Memory

| Detail | Value |
|---|---|
| **Total RAM** | 2,024 MB |
| **Swap** | 600 MB zram (`/dev/zram0`) |

### Storage

| Detail | Value |
|---|---|
| **Type** | eMMC |
| **Device** | Sandisk DG4008 |
| **Capacity** | ~7.3 GB (15,273,600 × 512-byte sectors) |
| **Health (life_time)** | `0x01 0x01` (0–10% used — excellent) |
| **User partition** | `/dev/mmcblk0p54` — 4.2 GB |
| **Cache partition** | `/dev/mmcblk0p53` — 488 MB |

### Connectivity

| Detail | Value |
|---|---|
| **Wi-Fi** | MediaTek MT7662U (USB, module `mt7662u_sta`) |
| **Bluetooth** | MediaTek (USB, module `btmtk_usb`) |
| **HDMI** | 4× HDMI 2.0 |
| **USB host** | xHCI + EHCI + OHCI controllers (8 buses) |

### Software

| Detail | Value |
|---|---|
| **Node.js** | v0.12.2 |
| **Chromium** | 38 (WebAppMgr) |
| **DVB tuners** | Silicon Labs si2178b + si2169d, RDA5815M |

### Kernel modules

| Module | Size | Description |
|---|---|---|
| `mali_kbase` | 304 kB | Mali T820 GPU driver |
| `galcore` | 468 kB | Vivante/LG graphics core |
| `mt7662u_sta` | 1.5 MB | MediaTek MT7662U Wi-Fi |
| `btmtk_usb` | 67 kB | MediaTek Bluetooth |
| `si2178b` / `si2169d` | — | DVB-T/T2/C/S tuner drivers |
| `tntfs` / `tfat` | — | Tuxera NTFS / FAT for USB media |
| `webos_tv` | 15 kB | LG webOS platform module |

### Overclocking potential

**CPU:** Not feasible from userspace. The cpufreq-dt driver only accepts
frequencies present in the device tree OPP table (600 / 1008 MHz). Writing
a higher value to `scaling_max_freq` is silently clamped. A kernel or DTB
patch would be required, with significant risk given the unknown voltage
regulator configuration.

**GPU:** No clock frequency controls are exposed. The Mali driver has no
debugfs mount and no sysfs clock nodes.

---

## LG OLED42C24LA (2022 — webOS 6/9)

| Detail | Value |
|---|---|
| **Model** | OLED42C24LA |
| **Firmware** | 23.25.55 |
| **webOS** | 9.2.2-61 (codename `ombre-okapi`, platform code `9`) |
| **Kernel** | Linux 5.4.268-320 (aarch64, SMP PREEMPT) |
| **SoC** | LG1213 / "O22" (AArch64) |
| **Chip ID** | `O22A2` (from boot cmdline) |

### CPU

| Detail | Value |
|---|---|
| **Architecture** | ARMv8.2-A — Cortex-A76 (CPU part `0xd0b`) |
| **Cores** | 4 (hotplug parks idle cores — typically 2–3 online) |
| **Frequency steps** | 1400 MHz (single fixed OPP) |
| **Governor** | `performance` (locked at 1400 MHz) |
| **Available governors** | conservative, ondemand, userspace, powersave, performance |
| **Scaling driver** | cpufreq-dt |
| **BogoMIPS** | 100.00 per core |
| **CPU voltage** | 0.92V (set via AVS — Adaptive Voltage Scaling) |

> [!NOTE]
> The C2 exposes only a single OPP (1400 MHz) with no lower step, so frequency
> scaling is effectively disabled — the CPU always runs at full speed or parks
> the core entirely. The `o22_cpuNP` and `o22_cpuHS` kernel parameters
> (Normal Performance / High Speed) are both `0`, and the voltage is regulated
> via LG's custom AVS system (`o22_cpu_avs=2`, `o22_core_avs=2`).

### GPU

| Detail | Value |
|---|---|
| **GPU** | Mali-G52 MP3 (r1p0, ID `0x07040002`) |
| **Shader cores** | 3 (core mask `0x7`) |
| **Power policy** | `coarse_demand` (available: always_on) |
| **DVFS period** | 100 ms |
| **Clock control** | Not directly exposed; `o22_gpuNP` / `o22_gpuHS` params exist but are `0` |

### Memory

| Detail | Value |
|---|---|
| **Total RAM** | 2,045 MB |
| **Swap** | 600 MB zram (`/dev/zram0`) |

### Storage

| Detail | Value |
|---|---|
| **Type** | eMMC |
| **Device** | Samsung 8GTF4R |
| **Capacity** | ~7.3 GB (15,269,888 × 512-byte sectors) |
| **Health (life_time)** | `0x01 0x01` (0–10% used — excellent) |
| **App store partition** | `/dev/mmcblk0p56` — 2.7 GB |
| **Common data** | `/dev/mmcblk0p55` — 721 MB |
| **Database** | `/dev/mmcblk0p54` — 103 MB |

### Connectivity

| Detail | Value |
|---|---|
| **Wi-Fi** | MediaTek MT7668 (USB, module `wlan_mt7668_usb`) |
| **Bluetooth** | MediaTek (USB, module `btmtk_usb`) |
| **HDMI** | 4× HDMI 2.1 (driver ver `20241107`, 480 MHz HDCP 2.3 ESM) |
| **eARC** | Supported (earc driver present) |
| **USB host** | xHCI + EHCI + OHCI + USB/IP virtual controllers (10 buses) |

### Software

| Detail | Value |
|---|---|
| **Node.js** | v16.19.1 |
| **Chromium** | 108.0.5359.211 (via CDP `User-Agent`) |
| **DVB tuners** | Silicon Labs si2178b, RDA5815M, LG SoC demod |

### Kernel modules

| Module | Size | Description |
|---|---|---|
| `mali_kbase` | built-in | Mali G52 GPU driver |
| `linux_hld_module` | 2.9 MB | Synopsys HDMI/HDCP host library driver |
| `wlan_mt7668_usb` | 2.0 MB | MediaTek MT7668 Wi-Fi |
| `btmtk_usb` | 115 kB | MediaTek Bluetooth |
| `aspectratiodrv` | 29 kB | Aspect ratio control |
| `si2178b` / `dvb_dtv_soc` | — | DVB tuner and SoC demod drivers |
| `webos_tv` | 82 kB | LG webOS platform module |

### LG1213 "O22" platform parameters

The C2's `lg1k` kernel module exposes a rich set of platform parameters via
`/sys/module/lg1k/parameters/`. Key ones related to performance:

| Parameter | Value | Description |
|---|---|---|
| `o22_cpuNP` | 0 | CPU Normal Performance target |
| `o22_cpuHS` | 0 | CPU High Speed target |
| `o22_gpuNP` | 0 | GPU Normal Performance target |
| `o22_gpuHS` | 0 | GPU High Speed target |
| `o22_cpu_avs` | 2 | CPU Adaptive Voltage Scaling mode |
| `o22_core_avs` | 2 | Core AVS mode |
| `o22_pms_enable` | 1 | Power Management System enabled |
| `o22_pms_tfreq` | 0 | PMS target frequency override |
| `o22_pms_tcorevol` | 0 | PMS target core voltage override |
| `o22_regul` | 1 | Voltage regulator active |
| `cpu_alp_mode` | 0 | CPU Always Low Power mode (disabled) |
| `ddr_alp_mode` | 1 | DDR Always Low Power mode (enabled) |

> [!WARNING]
> While `o22_cpuHS`, `o22_gpuHS`, and `o22_pms_tfreq` look like they *could*
> be override knobs, writing non-zero values without understanding the AVS
> voltage tables risks instability or hardware damage. LG's AVS calibration
> data is per-chip (`o22_avsinfo=0x170092`) and the voltage rails are
> tightly coupled.

### Overclocking potential

**CPU:** The single 1400 MHz OPP and the AVS system make overclocking
impractical without deep reverse engineering of the LG1213 PMS (Power
Management System). The `o22_cpuHS` and `o22_pms_tfreq` parameters hint at
a high-speed mode, but their semantics are undocumented and the voltage
regulator (`o22_regul=1`) is calibrated for the factory OPP.

**GPU:** The Mali-G52 MP3 has no exposed clock controls. The `o22_gpuHS`
parameter suggests a high-speed GPU mode may exist in firmware, but again,
undocumented and coupled to AVS.

---

## Quick comparison

| | B8 (2018) | C2 (2022) |
|---|---|---|
| **SoC** | LG1313 (ARMv7, 32-bit) | LG1213 "O22" (ARMv8, 64-bit) |
| **CPU** | 4× Cortex-A53 @ 1.0 GHz | 4× Cortex-A76 @ 1.4 GHz |
| **GPU** | Mali-T820 MP2 (2 cores) | Mali-G52 MP3 (3 cores) |
| **RAM** | 2 GB | 2 GB |
| **eMMC** | 7.3 GB (Sandisk) | 7.3 GB (Samsung) |
| **webOS** | 4.4.3 | 9.2.2 |
| **Kernel** | 4.4.84 (armv7l) | 5.4.268 (aarch64) |
| **Node.js** | v0.12.2 | v16.19.1 |
| **Chromium** | 38 | 108 |
| **Wi-Fi** | MT7662U | MT7668 |
| **HDMI** | 4× HDMI 2.0 | 4× HDMI 2.1 |
| **CPU governor** | performance (2-step DVFS) | performance (single OPP) |
| **OC potential** | Locked (2-step OPP table) | Locked (single OPP + AVS) |

### Generational leap

The jump from B8 → C2 is substantial:

- **CPU:** Cortex-A53 → A76 is a ~3× IPC improvement, plus 40% higher clock
  (1.0 → 1.4 GHz). Single-threaded performance roughly **4× faster**.
- **GPU:** Mali-T820 MP2 → G52 MP3 is ~3× the shader throughput at a newer
  architecture (Bifrost vs Midgard).
- **Chromium:** 38 → 108 brings ES6+, modern CSS, and vastly better JS
  performance (V8 10.8 vs V8 3.x).
- **Node.js:** v0.12 → v16 means async/await, modern APIs, and far better
  performance.
- **Storage & RAM:** Identical capacity, but the C2's Samsung eMMC is likely
  faster (UHS interface vs the B8's older controller).
