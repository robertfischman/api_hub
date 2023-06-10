import crypto from "crypto";
import mongoose from "mongoose";
import { nanoid } from "nanoid";
import Razorpay from "razorpay";
import {
  OrderStatusEnum,
  PaymentProviderEnum,
  paypalBaseUrl,
} from "../../../constants.js";
import { Address } from "../../../models/apps/ecommerce/address.models.js";
import { Cart } from "../../../models/apps/ecommerce/cart.models.js";
import { EcomOrder } from "../../../models/apps/ecommerce/order.models.js";
import { Product } from "../../../models/apps/ecommerce/product.models.js";
import { ApiError } from "../../../utils/ApiError.js";
import { ApiResponse } from "../../../utils/ApiResponse.js";
import { asyncHandler } from "../../../utils/asyncHandler.js";
import {
  orderConfirmationMailgenContent,
  sendEmail,
} from "../../../utils/mail.js";
import { getCart } from "./cart.controllers.js";

// TODO: move order fulfillment login to a common function which will handle order confirmation, product stock management and confirmation mail
// TODO: refactor the fetch calls from paypal controllers
// TODO: Include total order cost in the order confirmation mail

const generatePaypalAccessToken = async () => {
  try {
    const auth = Buffer.from(
      process.env.PAYPAL_CLIENT_ID + ":" + process.env.PAYPAL_SECRET
    ).toString("base64");

    const response = await fetch(`${paypalBaseUrl.sandbox}/v1/oauth2/token`, {
      method: "POST",
      body: "grant_type=client_credentials",
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });
    const data = await response.json();
    return data?.access_token;
  } catch (error) {
    throw new ApiError(500, "Error while generating paypal auth token");
  }
};

const razorpayInstance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const generateRazorpayOrder = asyncHandler(async (req, res) => {
  const { addressId } = req.body;

  // Check if address is valid and is of logged in user's
  const address = await Address.findOne({
    _id: addressId,
    owner: req.user._id,
  });

  if (!address) {
    throw new ApiError(404, "Address does not exists");
  }

  const cart = await Cart.findOne({
    owner: req.user._id,
  });

  if (!cart || !cart.items?.length) {
    throw new ApiError(400, "User cart is empty");
  }
  const orderItems = cart.items;
  const userCart = await getCart(req.user._id);

  // calculate the total price of the order
  const totalPrice = userCart.reduce((prev, curr) => {
    return prev + curr?.product?.price * curr?.quantity;
  }, 0);

  const orderOptions = {
    amount: parseInt(totalPrice) * 100, // in paisa
    currency: "INR", // Might accept from client
    receipt: nanoid(10),
  };

  razorpayInstance.orders.create(
    orderOptions,
    async function (err, razorpayOrder) {
      if (!razorpayOrder || (err && err.error)) {
        // Throwing ApiError here will not trigger the error handler middleware
        return res
          .status(err.statusCode)
          .json(
            new ApiResponse(
              err.statusCode,
              null,
              err.error.reason ||
                "Something went wrong while initialising the razorpay order."
            )
          );
      }

      // Create an order while we generate razorpay session
      // In case payment is done and there is some network issue in the payment verification api
      // We will at least have a record of the order
      const unpaidOrder = await EcomOrder.create({
        address: addressId,
        customer: req.user._id,
        items: orderItems,
        orderPrice: totalPrice ?? 0,
        paymentProvider: PaymentProviderEnum.RAZORPAY,
        paymentId: razorpayOrder.id,
      });
      if (unpaidOrder) {
        // if order is created then only proceed with the payment
        return res
          .status(200)
          .json(
            new ApiResponse(200, razorpayOrder, "Razorpay order generated")
          );
      } else {
        return res
          .status(500)
          .json(
            new ApiResponse(
              500,
              null,
              "Something went wrong while initialising the razorpay order."
            )
          );
      }
    }
  );
});

const verifyRazorpayPayment = asyncHandler(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
    req.body;

  let body = razorpay_order_id + "|" + razorpay_payment_id;

  let expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body.toString())
    .digest("hex");

  if (expectedSignature === razorpay_signature) {
    // TODO: Move following order fulfillment login in separate function and reuse it in paypal and razorpay
    // If payment is valid
    // Turn the payment status of the order yo true
    const order = await EcomOrder.findOneAndUpdate(
      {
        paymentId: razorpay_order_id,
      },
      {
        $set: {
          isPaymentDone: true,
        },
      },
      { new: true }
    );

    if (!order) {
      throw new ApiError(404, "Order does not exist");
    }

    // Get the user's card
    const cart = await Cart.findOne({
      owner: req.user._id,
    });

    const orderItems = await getCart(req.user._id);

    // Logic to handle product's stock change once order is placed
    let bulkStockUpdates = orderItems.map((item) => {
      // Reduce the products stock
      return {
        updateOne: {
          filter: { _id: item.product?._id },
          update: { $inc: { stock: -item.quantity } }, // subtract the item quantity
        },
      };
    });

    // * (bulkWrite()) is faster than sending multiple independent operations (e.g. if you use create())
    // * because with bulkWrite() there is only one network round trip to the MongoDB server.
    await Product.bulkWrite(bulkStockUpdates, {
      skipValidation: true,
    });

    await sendEmail({
      email: req.user?.email,
      subject: "Order confirmed",
      mailgenContent: orderConfirmationMailgenContent(
        req.user?.username,
        orderItems
      ),
    });

    cart.items = []; // empty the cart

    await cart.save({ validateBeforeSave: false });
    return res
      .status(201)
      .json(new ApiResponse(201, order, "Order placed successfully"));
  } else {
    throw new ApiError(400, "Invalid razorpay signature");
  }
});

const generatePaypalOrder = asyncHandler(async (req, res) => {
  const { addressId } = req.body;

  // Check if address is valid and is of logged in user's
  const address = await Address.findOne({
    _id: addressId,
    owner: req.user._id,
  });

  if (!address) {
    throw new ApiError(404, "Address does not exists");
  }

  const cart = await Cart.findOne({
    owner: req.user._id,
  });

  if (!cart || !cart.items?.length) {
    throw new ApiError(400, "User cart is empty");
  }
  const orderItems = cart.items; // these items are used further to set product stock
  const userCart = await getCart(req.user._id);

  // calculate the total price of the order
  const totalPrice = userCart.reduce((prev, curr) => {
    return prev + curr?.product?.price * curr?.quantity;
  }, 0);

  // create a new order
  const accessToken = await generatePaypalAccessToken();
  const url = `${paypalBaseUrl.sandbox}/v2/checkout/orders`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "USD",
            value: totalPrice * 0.012, // convert indian rupees to dollars
          },
        },
      ],
    }),
  });

  const paypalOrder = await response.json();

  if (paypalOrder?.id) {
    // Create an order while we generate paypal session
    // In case payment is done and there is some network issue in the payment verification api
    // We will at least have a record of the order
    const unpaidOrder = await EcomOrder.create({
      address: addressId,
      customer: req.user._id,
      items: orderItems,
      orderPrice: totalPrice ?? 0,
      paymentProvider: PaymentProviderEnum.PAYPAL,
      paymentId: paypalOrder.id,
    });
    if (unpaidOrder) {
      // if order is created then only proceed with the payment
      return res
        .status(201)
        .json(
          new ApiResponse(
            201,
            paypalOrder,
            "Paypal order generated successfully"
          )
        );
    }
  }
  // if there is no paypal order or unpaidOrder created throw an error
  throw new ApiError(
    500,
    "Something went wrong while initialising the paypal order."
  );
});

const verifyPaypalPayment = asyncHandler(async (req, res) => {
  const { orderId } = req.body;

  const accessToken = await generatePaypalAccessToken();
  const url = `${paypalBaseUrl.sandbox}/v2/checkout/orders/${orderId}/capture`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const capturedData = await response.json();

  if (capturedData?.status === "COMPLETED") {
    const order = await EcomOrder.findOneAndUpdate(
      {
        paymentId: capturedData.id,
      },
      {
        $set: {
          isPaymentDone: true,
        },
      },
      { new: true }
    );

    if (!order) {
      throw new ApiError(404, "Order does not exist");
    }

    const cart = await Cart.findOne({
      owner: req.user._id,
    });

    // User's cart and order model has the same structure
    // First get the items in the cart
    const orderItems = await getCart(req.user._id);

    // Logic to handle product's stock change once order is placed
    let bulkStockUpdates = orderItems.map((item) => {
      // Reduce the products stock
      return {
        updateOne: {
          filter: { _id: item.product?._id },
          update: { $inc: { stock: -item.quantity } }, // subtract the item quantity
        },
      };
    });

    // * (bulkWrite()) is faster than sending multiple independent operations (e.g. if you use create())
    // * because with bulkWrite() there is only one network round trip to the MongoDB server.
    await Product.bulkWrite(bulkStockUpdates, {
      skipValidation: true,
    });

    await sendEmail({
      email: req.user?.email,
      subject: "Order confirmed",
      mailgenContent: orderConfirmationMailgenContent(
        req.user?.username,
        orderItems
      ),
    });

    cart.items = [];

    await cart.save({ validateBeforeSave: false });
    return res
      .status(200)
      .json(new ApiResponse(200, order, "Order placed successfully"));
  } else {
    throw new ApiError(500, "Something went wrong with the paypal payment");
  }
});

const updateOrderStatus = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const { status } = req.body;

  let order = await EcomOrder.findById(orderId);

  if (!order) {
    throw new ApiError(404, "Order does not exist");
  }

  if (order.status === OrderStatusEnum.DELIVERED) {
    throw new ApiError(400, "Order is already delivered");
  }

  order = await EcomOrder.findByIdAndUpdate(
    orderId,
    {
      $set: {
        status,
      },
    },
    { new: true }
  );
  return res.status(200).json(
    new ApiResponse(
      200,
      {
        status,
      },
      "Order status changed successfully"
    )
  );
});

const getOrderById = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const order = await EcomOrder.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(orderId),
      },
    },
    // lookup for an address associated with the order
    {
      $lookup: {
        from: "addresses",
        localField: "address",
        foreignField: "_id",
        as: "address",
      },
    },
    // lookup for a customer associated with the order
    {
      $lookup: {
        from: "users",
        localField: "customer",
        foreignField: "_id",
        as: "customer",
        pipeline: [
          {
            $project: {
              _id: 1,
              username: 1,
              email: 1,
            },
          },
        ],
      },
    },
    // lookup returns array so get the first element of address and customer
    {
      $addFields: {
        customer: { $first: "$customer" },
        address: { $first: "$address" },
      },
    },
    // Now we have array of order items with productId being the id of the product that is being ordered
    // So we want to send complete details of that product

    // To do so we first unwind the items array
    { $unwind: "$items" },

    // it gives us documents with `items` being an object with ket {_id, productId, quantity}
    {
      // lookup for a product associated
      $lookup: {
        from: "products",
        localField: "items.productId",
        foreignField: "_id",
        as: "items.product", // store that looked up product in items.product key
      },
    },
    // As we know lookup will return an array
    // we want product key to be an object not array
    // So, once lookup is done we access first item in an array
    { $addFields: { "items.product": { $first: "$items.product" } } },
    // As we have unwind the items array the output of the following stages is not desired one
    // So to make it desired we need to group whatever we have unwinded
    {
      $group: {
        // we group the documents with `_id (which is an order id)`
        // The reason being, each order is unique and main entity of this api
        _id: "$_id",
        order: { $first: "$$ROOT" }, // we also assign whole root object to be the order
        // we create a new key orderItems in which we will push each order item (product details and quantity) with complete product details
        orderItems: {
          $push: {
            _id: "$items._id",
            quantity: "$items.quantity",
            product: "$items.product",
          },
        },
      },
    },
    {
      $addFields: {
        // now we will create a new items key in the order object and assign the orderItems value to it to keep everything in the `order` key
        "order.items": "$orderItems",
      },
    },
    {
      $project: {
        // ignore the orderItems key as we don't need it
        orderItems: 0,
      },
    },
  ]);

  if (!order[0]) {
    throw new ApiError(404, "Order does not exist");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, order[0], "Order fetched successfully"));
});

const getOrderListAdmin = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const orders = await EcomOrder.aggregate([
    {
      $match:
        status && Object.values(OrderStatusEnum).includes(status)
          ? {
              status: status,
            }
          : {},
    },
    {
      $lookup: {
        from: "addresses",
        localField: "address",
        foreignField: "_id",
        as: "address",
      },
    },
    // lookup for a customer associated with the order
    {
      $lookup: {
        from: "users",
        localField: "customer",
        foreignField: "_id",
        as: "customer",
        pipeline: [
          {
            $project: {
              _id: 1,
              username: 1,
              email: 1,
            },
          },
        ],
      },
    },
    {
      $addFields: {
        customer: { $first: "$customer" },
        address: { $first: "$address" },
        totalOrderItems: { $size: "$items" },
      },
    },
    {
      $project: {
        items: 0,
      },
    },
  ]);

  return res
    .status(200)
    .json(new ApiResponse(200, orders, "Orders fetched successfully"));
});

export {
  generateRazorpayOrder,
  generatePaypalOrder,
  verifyRazorpayPayment,
  verifyPaypalPayment,
  getOrderById,
  getOrderListAdmin,
  updateOrderStatus,
};
