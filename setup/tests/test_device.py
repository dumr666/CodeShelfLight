import sys
import unittest


from codeshelf_setup.device import Light, LightError

if sys.platform == "win32":
    raise unittest.SkipTest("the fake light needs a POSIX pseudo terminal")

from tests.fake_light import FakeLight  # noqa: E402


class DeviceTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeLight()
        self.light = Light(self.fake.port)

    def tearDown(self):
        self.light.close()

    def test_info_skips_logs_and_other_replies(self):
        info = self.light.info()
        self.assertEqual(info["config"]["name"], "CodeShelf Light 1A2B")
        self.assertEqual(info["status"]["wifiState"], "unconfigured")

    def test_set_wifi(self):
        result = self.light.set(ssid="Home", wifiPassword="password1")
        self.assertEqual(result["config"]["ssid"], "Home")
        self.assertEqual(self.fake.requests[-1]["config"], {"ssid": "Home", "wifiPassword": "password1"})

    def test_error_reply(self):
        with self.assertRaisesRegex(LightError, "8-63"):
            self.light.set(ssid="Home", wifiPassword="short")

    def test_scan(self):
        self.assertEqual(self.light.scan()[0]["ssid"], "Home")

    def test_no_answer(self):
        with self.assertRaisesRegex(LightError, "no answer"):
            self.light.request("silent", timeout=0.5)


if __name__ == "__main__":
    unittest.main()
