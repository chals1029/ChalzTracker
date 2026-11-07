"""Create the branded Electron runtime used by the Windows launcher.

Run after replacing dist-app/electron.exe. Requires Python on Windows; the
resulting application does not require Python.
"""
import ctypes
import shutil
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'dist-app' / 'electron.exe'
TARGET = ROOT / 'dist-app' / 'ChalzTracker-desktop.exe'


def block(key, value=b'', children=b'', kind=1):
    length = len(value) // 2 if kind else len(value)
    data = struct.pack('<HHH', 0, length, kind) + (key + '\0').encode('utf-16le')
    data += b'\0' * (-len(data) % 4)
    data += value
    data += b'\0' * (-len(data) % 4)
    data += children
    data += b'\0' * (-len(data) % 4)
    return struct.pack('<H', len(data)) + data[2:]


def text(key, value):
    return block(key, (value + '\0').encode('utf-16le'))


fixed = struct.pack('<13I', 0xFEEF04BD, 0x10000, 0x00020001, 0, 0x00020001, 0,
                    0x3F, 0, 0x40004, 1, 0, 0, 0)
strings = block('040904B0', children=b''.join(text(key, value) for key, value in (
    ('CompanyName', 'ChalzTracker'), ('FileDescription', 'ChalzTracker'),
    ('ProductName', 'ChalzTracker'), ('InternalName', 'ChalzTracker'),
    ('OriginalFilename', TARGET.name), ('FileVersion', '2.1.0'), ('ProductVersion', '2.1.0'),
)))
version = block('VS_VERSION_INFO', fixed,
                block('StringFileInfo', children=strings) +
                block('VarFileInfo', children=block('Translation', struct.pack('<HH', 1033, 1200), kind=0)),
                kind=0)

shutil.copyfile(SOURCE, TARGET)
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.BeginUpdateResourceW.argtypes = [ctypes.c_wchar_p, ctypes.c_bool]
kernel.BeginUpdateResourceW.restype = ctypes.c_void_p
kernel.UpdateResourceW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_ushort, ctypes.c_void_p, ctypes.c_uint]
kernel.EndUpdateResourceW.argtypes = [ctypes.c_void_p, ctypes.c_bool]
handle = kernel.BeginUpdateResourceW(str(TARGET), False)
if not handle:
    raise ctypes.WinError(ctypes.get_last_error())
def update_resource(resource_type, resource_id, data):
    buffer = ctypes.create_string_buffer(data)
    if not kernel.UpdateResourceW(handle, ctypes.c_void_p(resource_type), ctypes.c_void_p(resource_id), 1033, buffer, len(data)):
        error = ctypes.get_last_error()
        kernel.EndUpdateResourceW(handle, True)
        raise ctypes.WinError(error)


update_resource(16, 1, version)
ico = (ROOT / 'assets' / 'favicon.ico').read_bytes()
reserved, kind, count = struct.unpack_from('<HHH', ico)
if reserved != 0 or kind != 1 or not count:
    kernel.EndUpdateResourceW(handle, True)
    raise ValueError('Invalid application icon')
group = struct.pack('<HHH', reserved, kind, count)
for index in range(count):
    width, height, colors, reserved, planes, bits, size, offset = struct.unpack_from('<BBBBHHII', ico, 6 + index * 16)
    image = ico[offset:offset + size]
    if len(image) != size:
        kernel.EndUpdateResourceW(handle, True)
        raise ValueError('Invalid application icon image')
    resource_id = index + 1
    update_resource(3, resource_id, image)
    group += struct.pack('<BBBBHHIH', width, height, colors, reserved, planes, bits, size, resource_id)
update_resource(14, 1, group)
if not kernel.EndUpdateResourceW(handle, False):
    raise ctypes.WinError(ctypes.get_last_error())
print(f'Created {TARGET}')
