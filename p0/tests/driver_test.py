import importlib.util,json,subprocess,tempfile,unittest
from pathlib import Path
MODULE=Path(__file__).resolve().parents[2]/'scripts/p0.py'
spec=importlib.util.spec_from_file_location('p0_driver',MODULE);driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)
class DriverTests(unittest.TestCase):
 def test_existing_directory_is_never_overwritten(self):
  with tempfile.TemporaryDirectory() as tmp:
   with self.assertRaisesRegex(RuntimeError,'Refusing to overwrite'):driver.prepare(dest=Path(tmp))
 def test_partial_commit_is_rejected(self):
  with tempfile.TemporaryDirectory() as tmp:
   with self.assertRaisesRegex(RuntimeError,'40-character'):driver.prepare('a0d17d1',dest=Path(tmp)/'repo')
 def test_scanner_finds_sink_outside_helper(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);(root/'editor.js').write_text('async function save(){\n const w = await handle.createWritable();\n await w.write(text);\n}\n')
   result=driver.scan_paths(root,['editor.js'])
   self.assertTrue(any(x['line']==2 and x['category']=='js_fs_sink' for x in result['candidates']))
 def test_scanner_marks_tests_and_skips_vendor(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);(root/'tests').mkdir();(root/'vendor').mkdir()
   (root/'tests/a.js').write_text('write("x", "y")');(root/'vendor/a.js').write_text('write("x", "y")')
   result=driver.scan_paths(root,['tests/a.js','vendor/a.js'])
   self.assertTrue(result['candidates'][0]['test_code']);self.assertEqual(len(result['skipped_files']),1)
if __name__=='__main__':unittest.main()
