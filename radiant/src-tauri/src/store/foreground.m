// Local subject extraction for generated images with a textured, opaque background.
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <Vision/Vision.h>
#import <CoreVideo/CoreVideo.h>
#include <math.h>
#include <stdint.h>
#include <string.h>

// The Rust caller owns exactly width * height output bytes for the duration of this call.
bool radiant_foreground_alpha(const char *path, size_t width, size_t height, uint8_t *output) {
    if (@available(macOS 14.0, *)) {
        @autoreleasepool {
            NSURL *url = [NSURL fileURLWithFileSystemRepresentation:path isDirectory:NO relativeToURL:nil];
            CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
            if (!source) return false;
            NSDictionary *info = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
            CFRelease(source);
            if ([info[(__bridge NSString *)kCGImagePropertyPixelWidth] unsignedIntegerValue] != width ||
                [info[(__bridge NSString *)kCGImagePropertyPixelHeight] unsignedIntegerValue] != height) return false;

            VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithURL:url options:@{}];
            VNGenerateForegroundInstanceMaskRequest *request = [VNGenerateForegroundInstanceMaskRequest new];
            if (![handler performRequests:@[request] error:nil]) return false;
            VNInstanceMaskObservation *subject = request.results.firstObject;
            if (!subject.allInstances.count) return false;
            CVPixelBufferRef mask = [subject generateScaledMaskForImageForInstances:subject.allInstances
                                                                 fromRequestHandler:handler error:nil];
            if (!mask) return false;
            OSType format = CVPixelBufferGetPixelFormatType(mask);
            bool valid = CVPixelBufferGetWidth(mask) == width && CVPixelBufferGetHeight(mask) == height &&
                         (format == kCVPixelFormatType_OneComponent8 || format == kCVPixelFormatType_OneComponent32Float);
            if (valid && CVPixelBufferLockBaseAddress(mask, kCVPixelBufferLock_ReadOnly) == kCVReturnSuccess) {
                const uint8_t *base = CVPixelBufferGetBaseAddress(mask);
                size_t stride = CVPixelBufferGetBytesPerRow(mask);
                for (size_t y = 0; y < height; y++) {
                    const uint8_t *row = base + y * stride;
                    if (format == kCVPixelFormatType_OneComponent8) {
                        memcpy(output + y * width, row, width);
                    } else {
                        const float *weights = (const float *)row;
                        for (size_t x = 0; x < width; x++)
                            output[y * width + x] = (uint8_t)lrintf(255 * fmaxf(0, fminf(1, weights[x])));
                    }
                }
                CVPixelBufferUnlockBaseAddress(mask, kCVPixelBufferLock_ReadOnly);
            } else {
                valid = false;
            }
            CVPixelBufferRelease(mask);
            return valid;
        }
    }
    return false;
}
