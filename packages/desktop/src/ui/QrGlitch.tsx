import { useEffect, useState } from "react";

function useGreenQrImage(source: string | null) {
  const [greenQrImage, setGreenQrImage] = useState<string | null>(null);

  useEffect(() => {
    if (!source) {
      setGreenQrImage(null);
      return;
    }

    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;

      context.imageSmoothingEnabled = false;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < pixels.data.length; index += 4) {
        const alpha = pixels.data[index + 3] ?? 0;
        const luminance =
          (pixels.data[index] ?? 0) * 0.2126 +
          (pixels.data[index + 1] ?? 0) * 0.7152 +
          (pixels.data[index + 2] ?? 0) * 0.0722;
        const isQrPixel = alpha > 0 && luminance < 128;
        pixels.data[index] = isQrPixel ? 28 : 0;
        pixels.data[index + 1] = isQrPixel ? 212 : 0;
        pixels.data[index + 2] = isQrPixel ? 86 : 0;
        pixels.data[index + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      if (!cancelled) setGreenQrImage(canvas.toDataURL("image/png"));
    };
    image.src = source;

    return () => {
      cancelled = true;
    };
  }, [source]);

  return greenQrImage;
}

export function QrGlitch(props: {
  source: string;
  className?: string;
  alt?: string;
}) {
  const greenQrImage = useGreenQrImage(props.source);
  const className = ["config-qr-frame", props.className].filter(Boolean).join(" ");

  return (
    <span className={className}>
      <img
        className="config-qr-image config-qr-image-normal"
        src={props.source}
        alt={props.alt ?? "WeChat login QR code"}
      />
      <img
        className="config-qr-image config-qr-image-inverted"
        src={props.source}
        alt=""
        aria-hidden="true"
      />
      <img
        className="config-qr-image config-qr-image-green"
        src={greenQrImage ?? props.source}
        alt=""
        aria-hidden="true"
      />
      <img
        className="config-qr-image config-qr-image-glitch config-qr-glitch-normal"
        src={props.source}
        alt=""
        aria-hidden="true"
      />
      <img
        className="config-qr-image config-qr-image-glitch config-qr-glitch-inverted"
        src={props.source}
        alt=""
        aria-hidden="true"
      />
      <img
        className="config-qr-image config-qr-image-glitch config-qr-glitch-green"
        src={greenQrImage ?? props.source}
        alt=""
        aria-hidden="true"
      />
    </span>
  );
}
