# Stratum Test Images

This directory holds OS kernel images used by the test scripts. They are
**not** checked into git — download them before running tests.

## Aqeous OS

```bash
# From the Aqeous OS workspace shared storage:
cp /shared/aqeous/Aqeous.bin aqeous.bin

# Or build from source:
# https://github.com/AshishKumar4/Aqeous
# cd Kernel && make all  →  Kernel/Aqeous.bin
```

## KolibriOS (optional)

```bash
curl -L -o kolibri.img https://builds.kolibrios.org/eng/latest-iso.7z
# Extract the floppy image from the archive
```
