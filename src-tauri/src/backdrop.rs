//! Win32 host-backdrop composition. All objects live on the window's UI thread.
use std::cell::RefCell;
use windows::{
    core::{implement, Error, GUID, HSTRING, Interface, PCWSTR, HRESULT},
    Foundation::{IPropertyValue, PropertyValue},
    Graphics::Effects::{IGraphicsEffect, IGraphicsEffect_Impl, IGraphicsEffectSource, IGraphicsEffectSource_Impl},
    System::{DispatcherQueue, DispatcherQueueController},
    UI::Composition::{Compositor, CompositionEffectBrush, CompositionEffectFactory, CompositionEffectFactoryLoadStatus, CompositionEffectSourceParameter, ContainerVisual, Desktop::DesktopWindowTarget},
    Win32::{Foundation::HWND, Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_HOSTBACKDROPBRUSH}, System::WinRT::{CreateDispatcherQueueController, DispatcherQueueOptions, DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT, Composition::ICompositorDesktopInterop, Graphics::Direct2D::{IGraphicsEffectD2D1Interop, IGraphicsEffectD2D1Interop_Impl, GRAPHICS_EFFECT_PROPERTY_MAPPING}}},
};
use windows_numerics::{Vector2, Vector3};

#[implement(IGraphicsEffect, IGraphicsEffectSource, IGraphicsEffectD2D1Interop)]
struct GaussianBlur {
    source: IGraphicsEffectSource,
}
impl IGraphicsEffectSource_Impl for GaussianBlur_Impl {}
impl IGraphicsEffect_Impl for GaussianBlur_Impl {
    fn Name(&self) -> windows::core::Result<HSTRING> { Ok(HSTRING::new()) }
    fn SetName(&self, _: &HSTRING) -> windows::core::Result<()> { Ok(()) }
}
impl IGraphicsEffectD2D1Interop_Impl for GaussianBlur_Impl {
    fn GetEffectId(&self) -> windows::core::Result<GUID> { Ok(GUID::from_u128(0x1feb6d69_2fe6_4ac9_8c58_1d7f93e7a6a5)) }
    fn GetNamedPropertyMapping(&self, _: &PCWSTR, _: *mut u32, _: *mut GRAPHICS_EFFECT_PROPERTY_MAPPING) -> windows::core::Result<()> { Err(Error::from_hresult(HRESULT(0x80070057u32 as i32))) }
    fn GetPropertyCount(&self) -> windows::core::Result<u32> { Ok(3) }
    fn GetProperty(&self, index: u32) -> windows::core::Result<IPropertyValue> {
        match index {
            0 => PropertyValue::CreateSingle(24.0)?.cast(),
            1 => PropertyValue::CreateUInt32(1)?.cast(),
            2 => PropertyValue::CreateUInt32(1)?.cast(),
            _ => Err(Error::from_hresult(HRESULT(0x80070057u32 as i32))),
        }
    }
    fn GetSource(&self, index: u32) -> windows::core::Result<IGraphicsEffectSource> {
        if index == 0 { Ok(self.source.clone()) } else { Err(Error::from_hresult(HRESULT(0x80070057u32 as i32))) }
    }
    fn GetSourceCount(&self) -> windows::core::Result<u32> { Ok(1) }
}

struct Backdrop {
    hwnd: isize,
    _queue: Option<DispatcherQueueController>,
    compositor: Compositor,
    _target: DesktopWindowTarget,
    root: ContainerVisual,
    factory: CompositionEffectFactory,
    brush: CompositionEffectBrush,
}
thread_local! { static BACKDROP: RefCell<Option<Backdrop>> = const { RefCell::new(None) }; }

impl Backdrop {
    fn new(hwnd: isize) -> windows::core::Result<Self> {
        let hwnd_value = HWND(hwnd as *mut _);
        let enabled: i32 = 1;
        unsafe { DwmSetWindowAttribute(hwnd_value, DWMWA_USE_HOSTBACKDROPBRUSH, &enabled as *const _ as *const _, std::mem::size_of_val(&enabled) as u32)?; }
        let result = (|| {
            let queue = if DispatcherQueue::GetForCurrentThread().is_ok() { None } else {
                Some(unsafe { CreateDispatcherQueueController(DispatcherQueueOptions {
                    dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
                    threadType: DQTYPE_THREAD_CURRENT, apartmentType: DQTAT_COM_NONE,
                })? })
            };
            let compositor = Compositor::new()?;
            let target = unsafe { compositor.cast::<ICompositorDesktopInterop>()?.CreateDesktopWindowTarget(hwnd_value, false)? };
            let root = compositor.CreateContainerVisual()?;
            target.SetRoot(&root)?;
            let source = CompositionEffectSourceParameter::Create(&HSTRING::from("backdrop"))?;
            let effect: IGraphicsEffect = GaussianBlur { source: source.cast()? }.into();
            let factory = compositor.CreateEffectFactory(&effect)?;
            let brush = factory.CreateBrush()?;
            brush.SetSourceParameter(&HSTRING::from("backdrop"), &compositor.CreateHostBackdropBrush()?)?;
            Ok(Self { hwnd, _queue: queue, compositor, _target: target, root, factory, brush })
        })();
        if result.is_err() { disable_attribute(hwnd); }
        result
    }
    fn update(&self, regions: &[crate::desktop::GlassRegion], scale: f64, width: u32, height: u32) -> windows::core::Result<CompositionEffectFactoryLoadStatus> {
        let new_root = self.compositor.CreateContainerVisual()?;
        for region in regions {
            let x = (region.x * scale).max(0.0).min(width as f64);
            let y = (region.y * scale).max(0.0).min(height as f64);
            let right = ((region.x + region.width) * scale).max(0.0).min(width as f64);
            let bottom = ((region.y + region.height) * scale).max(0.0).min(height as f64);
            if right <= x || bottom <= y { continue; }
            let w = (right - x) as f32;
            let h = (bottom - y) as f32;
            let radius = ((region.radius * scale) as f32).min(w / 2.0).min(h / 2.0);
            let visual = self.compositor.CreateSpriteVisual()?;
            visual.SetOffset(Vector3 { X: x as f32, Y: y as f32, Z: 0.0 })?;
            visual.SetSize(Vector2 { X: w, Y: h })?;
            visual.SetBrush(&self.brush)?;
            let geometry = self.compositor.CreateRoundedRectangleGeometry()?;
            geometry.SetSize(Vector2 { X: w, Y: h })?;
            geometry.SetCornerRadius(Vector2 { X: radius, Y: radius })?;
            visual.SetClip(&self.compositor.CreateGeometricClipWithGeometry(&geometry)?)?;
            new_root.Children()?.InsertAtTop(&visual)?;
        }
        self.root.Children()?.RemoveAll()?;
        self.root.Children()?.InsertAtTop(&new_root)?;
        self.factory.LoadStatus()
    }
}
fn disable_attribute(hwnd: isize) {
    let disabled: i32 = 0;
    unsafe { let _ = DwmSetWindowAttribute(HWND(hwnd as *mut _), DWMWA_USE_HOSTBACKDROPBRUSH, &disabled as *const _ as *const _, std::mem::size_of_val(&disabled) as u32); }
}
pub fn update(hwnd: isize, regions: &[crate::desktop::GlassRegion], scale: f64, width: u32, height: u32) -> &'static str {
    BACKDROP.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.as_ref().map(|b| b.hwnd) != Some(hwnd) {
            *slot = match Backdrop::new(hwnd) {
                Ok(backdrop) => Some(backdrop),
                Err(error) => { eprintln!("Could not initialize the glass backdrop: {error}"); None }
            };
        }
        let status = match slot.as_ref() {
            Some(backdrop) => match backdrop.update(regions, scale, width, height) {
                Ok(CompositionEffectFactoryLoadStatus::Success) => "ready",
                Ok(CompositionEffectFactoryLoadStatus::Pending) => "pending",
                Ok(status) => { eprintln!("Glass shader failed with status {}", status.0); "unavailable" },
                Err(error) => { eprintln!("Could not update the glass backdrop: {error}"); "unavailable" }
            },
            None => "unavailable",
        };
        if status == "unavailable" { *slot = None; disable_attribute(hwnd); }
        status
    })
}
pub fn destroy() { BACKDROP.with(|slot| { if let Some(backdrop) = slot.borrow_mut().take() { disable_attribute(backdrop.hwnd); } }); }
