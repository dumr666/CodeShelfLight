import json
import tempfile
import unittest
from pathlib import Path

from codeshelf_setup.flasher import _Progress, load_package


class FlasherTest(unittest.TestCase):
    def test_load_package(self):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            (folder / "a.bin").write_bytes(b"x" * 10)
            (folder / "b.bin").write_bytes(b"x" * 30)
            (folder / "flash.json").write_text(json.dumps({
                "version": "1.2.3", "chip": "esp32s3", "flashMode": "qio", "flashFreq": "80m", "flashSize": "4MB",
                "parts": [{"offset": "0x0", "file": "a.bin"}, {"offset": "0x10000", "file": "b.bin"}]}))
            pkg = load_package(folder)
            self.assertEqual(pkg.version, "1.2.3")
            self.assertEqual([o for o, _ in pkg.parts], ["0x0", "0x10000"])
            self.assertEqual(pkg.total_size, 40)
            (folder / "b.bin").unlink()
            with self.assertRaises(FileNotFoundError):
                load_package(folder)

    def test_progress_spans_all_images(self):
        seen = []
        p = _Progress([10, 30], seen.append, lambda m: None)
        # Like esptool: compressed totals, and a bar can start above zero
        for cur in (2, 4):
            p.progress_bar(cur, 4)
        for cur in (8, 16):
            p.progress_bar(cur, 16)
        self.assertEqual([round(x, 3) for x in seen], [0.125, 0.25, 0.625, 1.0])


if __name__ == "__main__":
    unittest.main()
