#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>

// Write one tightly packed premultiplied RGBA thumbnail into the caller's
// side * side * 4 byte buffer. ImageIO chooses the decoder's reduced scale.
bool radiant_image_preview(const uint8_t *bytes, size_t length, size_t side,
                          uint8_t *pixels, size_t *width, size_t *height) {
    @autoreleasepool {
        NSData *data = [NSData dataWithBytesNoCopy:(void *)bytes length:length freeWhenDone:NO];
        NSDictionary *options = @{
            (__bridge NSString *)kCGImageSourceShouldCache: @NO,
            (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
            (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize: @(side)
        };
        CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data,
                                                              (__bridge CFDictionaryRef)options);
        if (!source) return false;
        CGImageRef thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
        CFRelease(source);
        if (!thumbnail) return false;
        size_t w = CGImageGetWidth(thumbnail), h = CGImageGetHeight(thumbnail);
        bool drawn = false;
        if (w && h && w <= side && h <= side) {
            CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
            CGContextRef context = CGBitmapContextCreate(pixels, w, h, 8, w * 4, color,
                                                         kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
            CGColorSpaceRelease(color);
            if (context) {
                CGContextDrawImage(context, CGRectMake(0, 0, w, h), thumbnail);
                CGContextRelease(context);
                *width = w;
                *height = h;
                drawn = true;
            }
        }
        CGImageRelease(thumbnail);
        return drawn;
    }
}
