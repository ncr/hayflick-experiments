//! Generic Vulkan plumbing: device context, buffers, images, barriers.
//! Nothing in here knows about the scene or the renderer — it's the thin
//! convenience layer every GPU-touching module builds on.

use ash::vk;
use std::ffi::CStr;

pub unsafe extern "system" fn debug_callback(
    severity: vk::DebugUtilsMessageSeverityFlagsEXT,
    _t: vk::DebugUtilsMessageTypeFlagsEXT,
    data: *const vk::DebugUtilsMessengerCallbackDataEXT<'_>,
    _u: *mut std::ffi::c_void,
) -> vk::Bool32 {
    eprintln!("[vk {severity:?}] {}", CStr::from_ptr((*data).p_message).to_string_lossy());
    vk::FALSE
}

pub fn find_memory_type(mp: &vk::PhysicalDeviceMemoryProperties, bits: u32, flags: vk::MemoryPropertyFlags) -> u32 {
    (0..mp.memory_type_count)
        .find(|&i| (bits & (1 << i)) != 0 && mp.memory_types[i as usize].property_flags.contains(flags))
        .expect("no memory type")
}

pub struct Buffer {
    pub buffer: vk::Buffer,
    pub memory: vk::DeviceMemory,
    pub address: u64,
}

pub struct GpuTex {
    pub image: vk::Image,
    pub memory: vk::DeviceMemory,
    pub view: vk::ImageView,
}

pub struct Ctx {
    pub device: ash::Device,
    pub as_dev: ash::khr::acceleration_structure::Device,
    pub queue: vk::Queue,
    pub pool: vk::CommandPool,
    pub mem_props: vk::PhysicalDeviceMemoryProperties,
}

impl Ctx {
    pub unsafe fn create_buffer(&self, size: u64, usage: vk::BufferUsageFlags, props: vk::MemoryPropertyFlags) -> Buffer {
        let want_addr = usage.contains(vk::BufferUsageFlags::SHADER_DEVICE_ADDRESS);
        let buffer = self
            .device
            .create_buffer(&vk::BufferCreateInfo::default().size(size.max(1)).usage(usage).sharing_mode(vk::SharingMode::EXCLUSIVE), None)
            .unwrap();
        let req = self.device.get_buffer_memory_requirements(buffer);
        let mut flags = vk::MemoryAllocateFlagsInfo::default().flags(vk::MemoryAllocateFlags::DEVICE_ADDRESS);
        let mut alloc = vk::MemoryAllocateInfo::default()
            .allocation_size(req.size)
            .memory_type_index(find_memory_type(&self.mem_props, req.memory_type_bits, props));
        if want_addr {
            alloc = alloc.push_next(&mut flags);
        }
        let memory = self.device.allocate_memory(&alloc, None).unwrap();
        self.device.bind_buffer_memory(buffer, memory, 0).unwrap();
        let address = if want_addr {
            self.device.get_buffer_device_address(&vk::BufferDeviceAddressInfo::default().buffer(buffer))
        } else {
            0
        };
        Buffer { buffer, memory, address }
    }

    pub unsafe fn destroy_buffer(&self, b: &Buffer) {
        self.device.destroy_buffer(b.buffer, None);
        self.device.free_memory(b.memory, None);
    }

    pub unsafe fn upload<T: Copy>(&self, b: &Buffer, data: &[T]) {
        if data.is_empty() {
            return;
        }
        let size = std::mem::size_of_val(data) as u64;
        let ptr = self.device.map_memory(b.memory, 0, size, vk::MemoryMapFlags::empty()).unwrap() as *mut T;
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        self.device.unmap_memory(b.memory);
    }

    pub unsafe fn device_local<T: Copy>(&self, data: &[T], usage: vk::BufferUsageFlags) -> Buffer {
        let size = (std::mem::size_of_val(data) as u64).max(1);
        let host = vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT;
        let staging = self.create_buffer(size, vk::BufferUsageFlags::TRANSFER_SRC, host);
        self.upload(&staging, data);
        let dst = self.create_buffer(size, usage | vk::BufferUsageFlags::TRANSFER_DST, vk::MemoryPropertyFlags::DEVICE_LOCAL);
        self.one_time(|cmd| {
            self.device.cmd_copy_buffer(cmd, staging.buffer, dst.buffer, &[vk::BufferCopy::default().size(size)]);
        });
        self.destroy_buffer(&staging);
        dst
    }

    pub unsafe fn one_time(&self, record: impl FnOnce(vk::CommandBuffer)) {
        let cmd = self
            .device
            .allocate_command_buffers(&vk::CommandBufferAllocateInfo::default().command_pool(self.pool).level(vk::CommandBufferLevel::PRIMARY).command_buffer_count(1))
            .unwrap()[0];
        self.device.begin_command_buffer(cmd, &vk::CommandBufferBeginInfo::default().flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT)).unwrap();
        record(cmd);
        self.device.end_command_buffer(cmd).unwrap();
        let fence = self.device.create_fence(&vk::FenceCreateInfo::default(), None).unwrap();
        let cmds = [cmd];
        self.device.queue_submit(self.queue, &[vk::SubmitInfo::default().command_buffers(&cmds)], fence).unwrap();
        self.device.wait_for_fences(&[fence], true, u64::MAX).unwrap();
        self.device.destroy_fence(fence, None);
        self.device.free_command_buffers(self.pool, &[cmd]);
    }

    /// Upload an RGBA8 image as a sampled texture. Base-colour textures are
    /// sRGB-encoded (glTF spec), so the image is created with an SRGB format —
    /// sampling converts to linear in hardware, matching what `hex_linear`
    /// does for flat colours.
    pub unsafe fn upload_texture(&self, img: &crate::scene::LoadedImage) -> GpuTex {
        let host = vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT;
        let staging = self.create_buffer(img.pixels.len() as u64, vk::BufferUsageFlags::TRANSFER_SRC, host);
        self.upload(&staging, &img.pixels);
        let format = vk::Format::R8G8B8A8_SRGB;
        let image = self
            .device
            .create_image(
                &vk::ImageCreateInfo::default()
                    .image_type(vk::ImageType::TYPE_2D)
                    .format(format)
                    .extent(vk::Extent3D { width: img.width, height: img.height, depth: 1 })
                    .mip_levels(1)
                    .array_layers(1)
                    .samples(vk::SampleCountFlags::TYPE_1)
                    .tiling(vk::ImageTiling::OPTIMAL)
                    .usage(vk::ImageUsageFlags::SAMPLED | vk::ImageUsageFlags::TRANSFER_DST)
                    .initial_layout(vk::ImageLayout::UNDEFINED),
                None,
            )
            .unwrap();
        let req = self.device.get_image_memory_requirements(image);
        let memory = self
            .device
            .allocate_memory(&vk::MemoryAllocateInfo::default().allocation_size(req.size).memory_type_index(find_memory_type(&self.mem_props, req.memory_type_bits, vk::MemoryPropertyFlags::DEVICE_LOCAL)), None)
            .unwrap();
        self.device.bind_image_memory(image, memory, 0).unwrap();
        let range = vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR, base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 };
        self.one_time(|cmd| {
            barrier(&self.device, cmd, image, vk::ImageLayout::UNDEFINED, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::AccessFlags::empty(), vk::AccessFlags::TRANSFER_WRITE, vk::PipelineStageFlags::TOP_OF_PIPE, vk::PipelineStageFlags::TRANSFER);
            let region = vk::BufferImageCopy::default()
                .image_subresource(vk::ImageSubresourceLayers { aspect_mask: vk::ImageAspectFlags::COLOR, mip_level: 0, base_array_layer: 0, layer_count: 1 })
                .image_extent(vk::Extent3D { width: img.width, height: img.height, depth: 1 });
            self.device.cmd_copy_buffer_to_image(cmd, staging.buffer, image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, &[region]);
            barrier(&self.device, cmd, image, vk::ImageLayout::TRANSFER_DST_OPTIMAL, vk::ImageLayout::SHADER_READ_ONLY_OPTIMAL, vk::AccessFlags::TRANSFER_WRITE, vk::AccessFlags::SHADER_READ, vk::PipelineStageFlags::TRANSFER, vk::PipelineStageFlags::COMPUTE_SHADER);
        });
        self.destroy_buffer(&staging);
        let view = self
            .device
            .create_image_view(&vk::ImageViewCreateInfo::default().image(image).view_type(vk::ImageViewType::TYPE_2D).format(format).subresource_range(range), None)
            .unwrap();
        GpuTex { image, memory, view }
    }
}

#[allow(clippy::too_many_arguments)]
pub unsafe fn barrier(device: &ash::Device, cmd: vk::CommandBuffer, image: vk::Image, old: vk::ImageLayout, new: vk::ImageLayout, sa: vk::AccessFlags, da: vk::AccessFlags, ss: vk::PipelineStageFlags, ds: vk::PipelineStageFlags) {
    let b = vk::ImageMemoryBarrier::default()
        .old_layout(old)
        .new_layout(new)
        .src_access_mask(sa)
        .dst_access_mask(da)
        .image(image)
        .subresource_range(vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR, base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 });
    device.cmd_pipeline_barrier(cmd, ss, ds, vk::DependencyFlags::empty(), &[], &[], &[b]);
}

pub unsafe fn make_storage_image(ctx: &Ctx, w: u32, h: u32, format: vk::Format) -> (vk::Image, vk::DeviceMemory, vk::ImageView) {
    let image = ctx
        .device
        .create_image(&vk::ImageCreateInfo::default().image_type(vk::ImageType::TYPE_2D).format(format).extent(vk::Extent3D { width: w, height: h, depth: 1 }).mip_levels(1).array_layers(1).samples(vk::SampleCountFlags::TYPE_1).tiling(vk::ImageTiling::OPTIMAL).usage(vk::ImageUsageFlags::STORAGE | vk::ImageUsageFlags::TRANSFER_SRC | vk::ImageUsageFlags::TRANSFER_DST).initial_layout(vk::ImageLayout::UNDEFINED), None)
        .unwrap();
    let req = ctx.device.get_image_memory_requirements(image);
    let mem = ctx.device.allocate_memory(&vk::MemoryAllocateInfo::default().allocation_size(req.size).memory_type_index(find_memory_type(&ctx.mem_props, req.memory_type_bits, vk::MemoryPropertyFlags::DEVICE_LOCAL)), None).unwrap();
    ctx.device.bind_image_memory(image, mem, 0).unwrap();
    let view = ctx.device.create_image_view(&vk::ImageViewCreateInfo::default().image(image).view_type(vk::ImageViewType::TYPE_2D).format(format).subresource_range(vk::ImageSubresourceRange { aspect_mask: vk::ImageAspectFlags::COLOR, base_mip_level: 0, level_count: 1, base_array_layer: 0, layer_count: 1 }), None).unwrap();
    (image, mem, view)
}

pub fn dslb(binding: u32, ty: vk::DescriptorType, count: u32) -> vk::DescriptorSetLayoutBinding<'static> {
    vk::DescriptorSetLayoutBinding::default().binding(binding).descriptor_type(ty).descriptor_count(count).stage_flags(vk::ShaderStageFlags::COMPUTE)
}
